import {
  Message,
  MessageAction,
  ScrapingState,
  PushSession,
  WorkerContact,
  RunSummary,
  Settings,
  isCompanyListUrl,
} from '../types';
import {
  getScrapingState,
  saveScrapingState,
  resetScrapingState,
  getScrapedProfiles,
  clearScrapedProfiles,
  getScrapedCompanies,
  clearScrapedCompanies,
  getSettings,
  getPushSession,
  savePushSession,
  clearPushSession,
  getRunState,
  saveRunState,
  clearRunState,
  INITIAL_SCRAPING_STATE,
} from '../utils/storage';
import { onMessage, broadcastStateUpdate, broadcastRun, sendError } from '../utils/messaging';
import { getGaussianDelayMs } from '../utils/timing';
import {
  fetchConfig,
  startRun,
  finishRun,
  normalizeWorkerUrl,
  WorkerConfig,
} from '../utils/worker-api';
import {
  advanceRun,
  createRunState,
  resetScoring,
  runProgress,
  type RunConfig,
  type RunState,
} from '../enrichment/runner';
import {
  incrementDailyCount,
  isDailyLimitReached,
  isWithinWorkingHours,
  nextWorkingHoursStart,
} from '../utils/safety';

// In-memory MIRROR of the persisted ScrapingState. Never trusted across event
// ticks — the MV3 SW dies after ~30s idle and module vars are lost. Every alarm
// handler and SW wake re-reads from chrome.storage before acting.
let currentState: ScrapingState = { ...INITIAL_SCRAPING_STATE };

// Selector health tracking (cosmetic badge only — OK to lose on SW death)
let degradedSelectorCount: number = 0;

// chrome.alarms names. Alarms persist across SW termination (setTimeout does
// not — Chrome kills MV3 workers after ~30s idle).
const AUTO_RESUME_ALARM = 'auto-resume';     // cooldown -> resume session
const NEXT_PAGE_ALARM = 'next-page';         // inter-page delay -> SCRAPE_PAGE
const WATCHDOG_ALARM = 'watchdog';           // repeating run-stall detector
const ENRICH_TICK_ALARM = 'enrich-tick';     // resumes a run whose service worker was killed

// Run is considered stalled when active with no pending delay/cooldown and no
// page progress for this long.
const STALL_TIMEOUT_MS = 5 * 60 * 1000;

// Chrome clamps repeating alarms to >=1 minute. The run normally drives itself
// in a tight loop; this alarm only matters when the service worker was killed
// between chunks, and it resumes from the persisted cursor.
const ENRICH_TICK_MINUTES = 1;

/**
 * Probe the content script with a no-op PING. Returns true if it responded.
 */
async function pingContentScript(tabId: number): Promise<boolean> {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { action: 'PING' });
    return response?.pong === true;
  } catch {
    return false;
  }
}

/**
 * Make sure the content script is loaded AND its message listener is registered
 * in `tabId`. Manifest-declared content scripts only inject on fresh page loads,
 * so a tab opened before the extension was (re)loaded won't have one. Programmatic
 * injection via chrome.scripting fixes that — but the CRXJS loader uses dynamic
 * imports, so executeScript resolves before the listener is actually registered.
 *
 * PING is retried a few times BEFORE injecting: a script that is mid-load (same
 * dynamic-import race) would fail a single probe, and injecting a second instance
 * doubles every message handler.
 */
async function ensureContentScriptInjected(tabId: number): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await pingContentScript(tabId)) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  const files = chrome.runtime.getManifest().content_scripts?.[0]?.js;
  if (!files || files.length === 0) {
    throw new Error('No content script files declared in manifest');
  }

  await chrome.scripting.executeScript({ target: { tabId }, files });
  console.log(`[BACKGROUND] Injected content script into tab ${tabId}, waiting for ready...`);

  // Poll until the listener answers, or timeout.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
    if (await pingContentScript(tabId)) {
      console.log(`[BACKGROUND] Content script ready in tab ${tabId}`);
      return;
    }
  }
  throw new Error('Content script did not become responsive within 5s after injection');
}

// ─── Run Session Tracking ───
//
// A run = one click of Start Scraping through to its end (natural completion,
// user Stop, error, daily-limit, or cooldown-without-auto-resume). The session
// carries the label and the Sales Navigator URL through to the enrichment job,
// and survives SW restarts (e.g. cooldown) via chrome.storage.local.

async function startRunSession(label: string, tabId: number): Promise<void> {
  const existing = await getPushSession();
  if (existing && !existing.endedAt) {
    console.log('[BACKGROUND] Previous run session was never finalized, packaging it now');
    await finalizeSession(existing, 'interrupted');
  }

  let salesNavUrl = '';
  let tabTitle = '';
  try {
    const tab = await chrome.tabs.get(tabId);
    salesNavUrl = tab.url || '';
    tabTitle = tab.title || '';
  } catch (err: any) {
    console.warn('[BACKGROUND] Could not read tab metadata for run session:', err?.message);
  }

  const session: PushSession = {
    startedAt: new Date().toISOString(),
    endedAt: null,
    endReason: null,
    label,
    salesNavUrl,
    tabTitle,
    totals: { pagesScraped: 0, profilesScraped: 0 },
  };
  await savePushSession(session);
  console.log('[BACKGROUND] Run session started:', { label, salesNavUrl });
}

/**
 * Record page progress on the persisted session as it happens, so an
 * 'interrupted' finalize after a SW/extension restart still reports the
 * real page count (module vars don't survive; the session does).
 */
async function recordPageScraped(pagesCompleted: number, profilesScraped: number): Promise<void> {
  const session = await getPushSession();
  if (!session) return;
  if (pagesCompleted > session.totals.pagesScraped) {
    session.totals.pagesScraped = pagesCompleted;
  }
  session.totals.profilesScraped += profilesScraped;
  await savePushSession(session);
}

/**
 * End the run session.
 *
 * The scraped rows are LEFT in place: `startEnrichment` consumes and clears
 * them once the run is durably persisted. Ending a session must never discard
 * a scrape, so nothing is deleted here.
 */
async function finalizeSession(
  session: PushSession,
  endReason: PushSession['endReason'],
): Promise<void> {
  session.endedAt = new Date().toISOString();
  session.endReason = endReason;

  const persisted = await getScrapingState();
  session.totals.pagesScraped = Math.max(session.totals.pagesScraped, persisted.lastCompletedPage);
  await savePushSession(session);
}

/**
 * Close the scraping session and, when configured, hand its rows straight to
 * the enrichment run. Auto-start is skipped while a run is only PAUSED (a
 * cooldown with auto-resume armed) — more pages are still coming.
 */
async function endRunSession(endReason: PushSession['endReason']): Promise<void> {
  const session = await getPushSession();
  if (session) {
    await finalizeSession(session, endReason);
    await clearPushSession();
  }

  const scraped = await getScrapedProfiles();
  if (scraped.length === 0) return;

  const settings = await getSettings();
  if (!settings.autoEnrichOnComplete) {
    console.log('[BACKGROUND] Auto-enrich disabled — rows kept for a manual start');
    await broadcastRunState(await getRunState());
    return;
  }

  const result = await startEnrichment(session ?? null);
  if (!result.success) {
    // The rows stay in storage; the popup offers a manual retry.
    console.warn('[BACKGROUND] Auto-enrich did not start:', result.error);
    chrome.runtime
      .sendMessage({ action: 'ENRICHMENT_ERROR', data: { message: result.error } })
      .catch(() => {});
  }
}

// ─── Enrichment run driver ───
//
// This is what the Cloudflare Workflow used to be. It lives here because the
// Workers free plan caps an invocation at 50 subrequests and 10ms CPU, and a
// 1000-contact run needs ~4,300 subrequests plus ~500ms to build the workbook.
// The worker keeps the credentials; the browser does the work.

// Guards against two ticks driving the same run inside one SW life.
let tickInProgress = false;

function workerConfigFrom(settings: Settings): WorkerConfig {
  return { workerUrl: normalizeWorkerUrl(settings.workerUrl), apiToken: settings.apiToken || '' };
}

/** Shape the persisted run for the popup — the full state is megabytes. */
export function summarize(state: RunState | null): RunSummary | null {
  if (!state) return null;
  const progress = runProgress(state);
  const active =
    state.phase === 'enriching' ||
    state.phase === 'companies' ||
    state.phase === 'contacts' ||
    state.phase === 'scoring';
  return {
    active,
    phase: state.phase,
    phaseLabel: progress.label,
    done: progress.done,
    total: progress.total,
    contactCount: state.contacts.length,
    scoredCount: state.scores.filter((s) => s.score).length,
    label: state.label,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    error: state.error,
    harvestCalls: state.totals.harvestCalls,
    llmCalls: state.totals.llmCalls,
    // Enriched rows are worth exporting even if scoring never finished.
    downloadable: state.enriched.length > 0 && !active,
  };
}

async function broadcastRunState(state: RunState | null): Promise<void> {
  broadcastRun(summarize(state));
  await refreshBadge();
}

/**
 * Turn the scraped rows into a run and start it.
 * Deduplicates by LinkedIn URL — a resumed scrape can re-cover a page boundary,
 * and paying to enrich the same person twice is pure waste.
 */
async function startEnrichment(session: PushSession | null): Promise<{ success: boolean; error?: string }> {
  const existing = await getRunState();
  if (existing && summarize(existing)?.active) {
    return { success: false, error: 'An enrichment run is already in progress.' };
  }

  const profiles = await getScrapedProfiles();
  if (profiles.length === 0) {
    return { success: false, error: 'Nothing scraped to enrich.' };
  }

  const seen = new Set<string>();
  const contacts: WorkerContact[] = [];
  for (const profile of profiles) {
    const url = (profile.profileUrl || '').trim();
    if (!url) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    contacts.push({
      linkedin_url: url,
      name: profile.name || undefined,
      title: profile.title || undefined,
      company: profile.company || undefined,
      location: profile.location || undefined,
    });
  }

  if (contacts.length === 0) return { success: false, error: 'No valid LinkedIn URLs to enrich.' };

  const settings = await getSettings();
  const config = workerConfigFrom(settings);
  if (!config.workerUrl || !config.apiToken) {
    return { success: false, error: 'Configure the worker URL and API token in Settings.' };
  }

  // Fail here rather than after burning credits: a bad token or an unreachable
  // worker shows up on this call.
  let runConfig: RunConfig;
  try {
    runConfig = await fetchConfig(config);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }

  if (contacts.length > runConfig.maxContactsPerRun) {
    return {
      success: false,
      error: `${contacts.length} contacts exceeds the worker's limit of ${runConfig.maxContactsPerRun}.`,
    };
  }

  const state = createRunState(contacts, {
    label: session?.label || settings.label || 'salesnav',
    icp: settings.icp || '',
    now: Date.now(),
  });
  state.runId = await startRun(config, {
    label: state.label,
    contactCount: contacts.length,
    icp: state.icp || undefined,
  });

  await saveRunState(state);
  // Only clear the scraped rows once the run is durably persisted.
  await clearScrapedProfiles();
  await chrome.alarms.create(ENRICH_TICK_ALARM, {
    delayInMinutes: ENRICH_TICK_MINUTES,
    periodInMinutes: ENRICH_TICK_MINUTES,
  });
  await broadcastRunState(state);

  console.log(`[BACKGROUND] Enrichment started: ${contacts.length} contacts`);
  driveRun().catch((err) => console.error('[BACKGROUND] driveRun failed:', err));
  return { success: true };
}

/**
 * Drive the run to completion, one chunk at a time.
 *
 * The in-flight fetches keep the service worker alive, so this usually runs to
 * the end in one go. If Chrome kills it anyway, every chunk boundary has been
 * persisted and ENRICH_TICK_ALARM calls this again to resume from the cursor.
 */
async function driveRun(): Promise<void> {
  if (tickInProgress) return;
  tickInProgress = true;

  try {
    const settings = await getSettings();
    const config = workerConfigFrom(settings);
    if (!config.workerUrl || !config.apiToken) return;

    let state = await getRunState();
    if (!state || !summarize(state)?.active) {
      await chrome.alarms.clear(ENRICH_TICK_ALARM);
      return;
    }

    let runConfig: RunConfig;
    try {
      runConfig = await fetchConfig(config);
    } catch (err) {
      console.warn('[BACKGROUND] Could not fetch config, will retry on next tick:', err);
      return;
    }

    let more = true;
    while (more) {
      more = await advanceRun(state, {
        workerUrl: config.workerUrl,
        apiToken: config.apiToken,
        config: runConfig,
        save: async (next) => {
          await saveRunState(next);
          await broadcastRunState(next);
        },
        shouldStop: async () => {
          const fresh = await getRunState();
          return fresh?.phase === 'stopped';
        },
      });
    }

    state = (await getRunState()) ?? state;
    if (!summarize(state)?.active) {
      await chrome.alarms.clear(ENRICH_TICK_ALARM);
      if (state.runId) {
        await finishRun(config, state.runId, {
          status: state.phase,
          scoredCount: state.scores.filter((s) => s.score).length,
          harvestCalls: state.totals.harvestCalls,
          llmCalls: state.totals.llmCalls,
          llmTokensIn: state.totals.llmTokensIn,
          llmTokensOut: state.totals.llmTokensOut,
          error: state.error,
        });
      }
      if (state.error) {
        chrome.runtime
          .sendMessage({ action: 'ENRICHMENT_ERROR', data: { message: state.error } })
          .catch(() => {});
      }
      await broadcastRunState(state);
      console.log(`[BACKGROUND] Enrichment ${state.phase}`);
    }
  } finally {
    tickInProgress = false;
  }
}

/** Badge shows a finished run waiting to be downloaded. */
async function refreshBadge(): Promise<void> {
  const summary = summarize(await getRunState());

  if (summary?.active) {
    const percent = summary.total > 0 ? Math.floor((summary.done / summary.total) * 100) : 0;
    await chrome.action.setBadgeText({ text: `${percent}` });
    await chrome.action.setBadgeBackgroundColor({ color: '#0a66c2' });
    return;
  }
  if (summary?.downloadable) {
    await chrome.action.setBadgeText({ text: '\u2713' });
    await chrome.action.setBadgeBackgroundColor({ color: '#2f855a' });
    return;
  }
  if (degradedSelectorCount >= 3) {
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#ff9800' });
    return;
  }
  await chrome.action.setBadgeText({ text: '' });
}


// ─── Initialization ───

// Single init promise so every message/alarm handler can `await ensureInitialized()`
// and never act on the stale module-level currentState after a SW restart.
let initPromise: Promise<void> | null = null;

// Set SYNCHRONOUSLY by the onInstalled/onStartup listeners before they await
// anything: initialize() must not fire its missed-deadline resumeNextPage while
// a hard reset is about to finalize the run.
let hardResetPending = false;

function ensureInitialized(): Promise<void> {
  if (!initPromise) initPromise = initialize();
  return initPromise;
}

/**
 * Initialize the background service worker (runs once per SW life).
 *
 * Does NOT reset an active run: mid-run state (scrapingTabId, lastCompletedPage,
 * nextScrapeAt) is persisted, so a run survives SW death — page completions and
 * the next-page alarm pick it up. Hard resets only happen on extension
 * reload/update (onInstalled) and browser startup (onStartup), where content
 * scripts are genuinely orphaned.
 */
async function initialize() {
  console.log('SalesNav Enrichment background service worker initialized');

  currentState = await getScrapingState();

  // The SW may have died during a short (<30s) setTimeout inter-page delay,
  // missing the deadline. Resume immediately (idempotent — no-ops if the
  // next-page alarm already handled it). Skipped when a hard reset is pending.
  if (
    !hardResetPending &&
    currentState.isActive &&
    currentState.nextScrapeAt !== null &&
    Date.now() >= currentState.nextScrapeAt
  ) {
    console.log('[BACKGROUND] Missed next-page deadline detected on SW wake, resuming');
    resumeNextPage().catch((err) => console.error('[BACKGROUND] resumeNextPage on init failed:', err));
  }

  // Leftovers from a previous SW life: undelivered runs and unfinished jobs.
  // A run interrupted by a service-worker death resumes from its cursor.
  const run = await getRunState();
  if (summarize(run)?.active) {
    console.log(`[BACKGROUND] Resuming enrichment (${run!.phase})`);
    await chrome.alarms.create(ENRICH_TICK_ALARM, {
      delayInMinutes: ENRICH_TICK_MINUTES,
      periodInMinutes: ENRICH_TICK_MINUTES,
    });
    driveRun().catch((err) => console.error('[BACKGROUND] Resume failed:', err));
  }
  await refreshBadge();
}

/**
 * Hard reset on extension reload/update or browser startup: any previous run is
 * genuinely dead (content scripts orphaned), so package its scraped rows,
 * clear alarms/state, and retry any undelivered submissions.
 */
async function hardResetOnReload(reason: string): Promise<void> {
  await ensureInitialized();
  console.log(`[BACKGROUND] Hard reset (${reason})`);

  await chrome.alarms.clear(AUTO_RESUME_ALARM);
  await chrome.alarms.clear(NEXT_PAGE_ALARM);
  await chrome.alarms.clear(WATCHDOG_ALARM);

  const session = await getPushSession();
  if (session && !session.endedAt) {
    await finalizeSession(session, 'interrupted');
    await clearPushSession();
  }

  await resetScrapingState();
  currentState = await getScrapingState();
  hardResetPending = false;

  const run = await getRunState();
  if (summarize(run)?.active) {
    console.log('[BACKGROUND] Resuming enrichment after reset');
    driveRun().catch((err) => console.error('[BACKGROUND] Resume failed:', err));
  }
}

/**
 * Send a message to only the active scraping tab (not all SalesNav tabs).
 * Reads the tab id from persisted state — survives SW restarts mid-run.
 */
async function sendToScrapingTab(action: MessageAction, data?: any): Promise<void> {
  const tabId = currentState.scrapingTabId;
  if (!tabId) {
    console.warn('[BACKGROUND] No scraping tab ID set, cannot send', action);
    return;
  }

  const message: Message = { action, data };
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch (err: any) {
    console.error(`[BACKGROUND] Error sending ${action} to tab ${tabId}:`, err?.message);
  }
}

/**
 * Auto-resume scraping after cooldown.
 * Reuses the same tab, resets session page count, keeps cumulative totals.
 * Reads resumeTabId from persisted state because the SW may have been
 * terminated and restarted while the alarm was pending.
 */
async function autoResume() {
  // Make sure we have the freshest persisted state — the SW may have just woken up.
  currentState = await getScrapingState();

  const settings = await getSettings();
  if (await isDailyLimitReached(settings.dailyLimit)) {
    console.log('[BACKGROUND] Auto-resume cancelled: daily limit reached');
    await endRunSession('daily_limit');
    sendError({ message: `Daily limit reached (${settings.dailyLimit} profiles). Auto-resume cancelled.` });
    return;
  }

  // Working-hours check (same guard the popup applies on manual start): if the
  // cooldown ended outside working hours, defer the resume to the next start
  // hour instead of scraping at an unusual time.
  // NOTE: this intentionally overrides a manual "continue anyway" start made
  // outside working hours — an UNATTENDED resume shouldn't scrape at odd hours
  // even if the attended start did.
  if (!isWithinWorkingHours(settings.workingHoursStart, settings.workingHoursEnd)) {
    const when = nextWorkingHoursStart(settings.workingHoursStart);
    console.log(`[BACKGROUND] Auto-resume outside working hours, deferred to ${new Date(when).toLocaleString()}`);
    currentState.cooldownUntil = when;
    await saveScrapingState(currentState);
    await chrome.alarms.create(AUTO_RESUME_ALARM, { when });
    broadcastStateUpdate(currentState);
    return;
  }

  const tabId = currentState.resumeTabId;
  if (!tabId) {
    console.log('[BACKGROUND] Auto-resume cancelled: no tab to resume on');
    await endRunSession('tab_lost');
    return;
  }

  try {
    await chrome.tabs.get(tabId);
  } catch {
    console.log(`[BACKGROUND] Auto-resume cancelled: tab ${tabId} no longer exists`);
    currentState.resumeTabId = null;
    await saveScrapingState(currentState);
    await endRunSession('tab_lost');
    return;
  }

  // Reset session counters but keep cumulative totals
  currentState.isActive = true;
  currentState.sessionPageCount = 0;
  currentState.cooldownUntil = null;
  currentState.resumeTabId = null;
  currentState.scrapingTabId = tabId;
  currentState.currentPage += 1;
  currentState.lastCompletedPage = currentState.currentPage - 1;
  currentState.lastProgressAt = Date.now();

  console.log(`[BACKGROUND] Auto-resuming scraping on tab ${tabId}, page ${currentState.currentPage}`);

  await saveScrapingState(currentState);
  broadcastStateUpdate(currentState);

  try {
    await ensureContentScriptInjected(tabId);
  } catch (err: any) {
    // isActive=true was already persisted above — just returning would leave a
    // permanently-active run that the already-active guard makes un-startable.
    console.error('[BACKGROUND] Auto-resume cancelled: could not inject content script:', err?.message);
    await haltRun('error', `Auto-resume failed: could not reach the scraper on the page (${err?.message || err}). Refresh the Sales Navigator page and start again.`);
    return;
  }

  // Run is live again — re-arm the stall watchdog (it self-clears during cooldown).
  await chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 2 });

  await sendToScrapingTab('START_SCRAPING');
  await new Promise(resolve => setTimeout(resolve, 100));
  await sendToScrapingTab('SCRAPE_PAGE', { page: currentState.currentPage });
}

/**
 * Handle START_SCRAPING message from popup.
 * payload.targetPageCount: null = unlimited; positive int = stop after N completed pages.
 */
async function handleStartScraping(payload?: { targetPageCount?: number | null }) {
  console.log('[BACKGROUND] Starting scraping process', payload || '');

  // Refuse to start while a run is in flight — a second Start (e.g. from a
  // re-opened popup) would wipe the in-flight session's counters.
  if (currentState.isActive) {
    const msg = `A scraping run is already active (page ${currentState.currentPage}). Stop it before starting a new one.`;
    console.warn('[BACKGROUND]', msg);
    return { success: false, error: msg };
  }

  // Cancel any pending auto-resume alarm (starting fresh during a cooldown is
  // an intentional restart) and any stale next-page alarm.
  await chrome.alarms.clear(AUTO_RESUME_ALARM);
  await chrome.alarms.clear(NEXT_PAGE_ALARM);

  // Rows left from a scrape that never reached enrichment would otherwise be
  // mixed into this run's results. Hand them over first if the user wants them.
  const orphaned = await getScrapedProfiles();
  if (orphaned.length > 0) {
    console.log(`[BACKGROUND] ${orphaned.length} rows from a previous scrape found`);
    const previous = await getPushSession();
    const settings = await getSettings();
    if (settings.autoEnrichOnComplete) {
      await startEnrichment(previous ?? null);
    }
    await clearPushSession();
  }

  await clearScrapedProfiles();

  // Find the active SalesNav tab to scrape — only use this one tab
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true, url: 'https://www.linkedin.com/sales/*' });

  let scrapingTabId: number;
  if (tabs.length === 0) {
    const allTabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/sales/*' });
    if (allTabs.length === 0) {
      console.error('[BACKGROUND] No LinkedIn Sales Navigator tabs found');
      return { success: false, error: 'No Sales Navigator tab found. Please open a Sales Navigator page.' };
    }
    scrapingTabId = allTabs[0].id!;
  } else {
    scrapingTabId = tabs[0].id!;
  }

  // Company list tab = company run: rows go to their own store, no enrichment.
  // A new company run replaces any undownloaded company rows (same semantics
  // as contacts, whose store is cleared above).
  let mode: ScrapingState['mode'] = 'contacts';
  try {
    const tab = await chrome.tabs.get(scrapingTabId);
    if (isCompanyListUrl(tab.url || '')) mode = 'companies';
  } catch {
    // Tab metadata unavailable — default to contacts.
  }
  if (mode === 'companies') {
    console.log('[BACKGROUND] Company list detected — company scrape run (no enrichment)');
    await clearScrapedCompanies();
  }

  const target = payload?.targetPageCount;
  currentState = {
    ...INITIAL_SCRAPING_STATE,
    isActive: true,
    mode,
    currentPage: 1,
    targetPageCount: typeof target === 'number' && target > 0 ? Math.floor(target) : null,
    scrapingTabId,
    lastProgressAt: Date.now(),
  };
  degradedSelectorCount = 0;

  await saveScrapingState(currentState);
  broadcastStateUpdate(currentState);
  await refreshBadge();

  // The tab may have been open before the extension was (re)loaded, in which
  // case the manifest-declared content script never ran on it. Inject if needed.
  try {
    await ensureContentScriptInjected(scrapingTabId);
  } catch (err: any) {
    const errMsg = `Could not load scraper on this tab: ${err?.message || err}. Refresh the Sales Navigator page and try again.`;
    console.error('[BACKGROUND]', errMsg);
    currentState.isActive = false;
    currentState.scrapingTabId = null;
    await saveScrapingState(currentState);
    broadcastStateUpdate(currentState);
    sendError({ message: errMsg });
    return { success: false, error: errMsg };
  }

  const settings = await getSettings();
  await startRunSession(settings.label || 'salesnav', scrapingTabId);

  // Arm the stall watchdog for the lifetime of the run.
  await chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 2 });

  await sendToScrapingTab('START_SCRAPING');
  // Small delay to ensure content script processes START_SCRAPING before SCRAPE_PAGE
  await new Promise(resolve => setTimeout(resolve, 100));
  await sendToScrapingTab('SCRAPE_PAGE', { page: currentState.currentPage });

  return { success: true, state: currentState };
}

/**
 * Handle STOP_SCRAPING message from popup
 */
async function handleStopScraping() {
  console.log('Stopping scraping process');

  await chrome.alarms.clear(AUTO_RESUME_ALARM);
  await chrome.alarms.clear(NEXT_PAGE_ALARM);
  await chrome.alarms.clear(WATCHDOG_ALARM);

  currentState.isActive = false;
  currentState.cooldownUntil = null;
  currentState.resumeTabId = null;
  currentState.nextScrapeAt = null;
  await saveScrapingState(currentState);
  broadcastStateUpdate(currentState);

  await sendToScrapingTab('STOP_SCRAPING');
  currentState.scrapingTabId = null;
  await saveScrapingState(currentState);

  // Package + submit after the tab is told to stop, so nothing else appends.
  await endRunSession('stopped');

  return { success: true, state: currentState };
}

async function handleGetStatus() {
  return currentState;
}

// ─── Next-Page Scheduling ───
//
// The combined pre-page delay (inter-page Gaussian delay + occasional distraction
// pause + occasional long dwell) can far exceed the ~30s MV3 SW idle kill —
// maxDelay alone goes up to 120s in Options. So the delay is NEVER awaited with
// a bare setTimeout: the deadline is persisted as state.nextScrapeAt and armed
// as a chrome.alarm (which survives SW death). For sub-30s delays a setTimeout
// races the alarm for precision; resumeNextPage is idempotent so a double fire
// is harmless.

let resumeNextPageInFlight = false;

async function scheduleNextPage(delayMs: number): Promise<void> {
  const when = Date.now() + delayMs;
  currentState.nextScrapeAt = when;
  await saveScrapingState(currentState);

  await chrome.alarms.create(NEXT_PAGE_ALARM, { when });
  if (delayMs < 30000) {
    setTimeout(() => {
      resumeNextPage().catch((err) => console.error('[BACKGROUND] resumeNextPage (timer) failed:', err));
    }, delayMs);
  }
  console.log(`[BACKGROUND] Page ${currentState.currentPage} scheduled in ${Math.round(delayMs / 1000)}s (alarm-backed)`);
}

/**
 * Fire the scheduled SCRAPE_PAGE. Called by the next-page alarm, the short-delay
 * setTimeout, or initialize() (missed deadline after SW death). Reads everything
 * from STORAGE — module vars cannot be trusted after a SW restart.
 */
async function resumeNextPage(): Promise<void> {
  if (resumeNextPageInFlight) return;
  resumeNextPageInFlight = true;
  try {
    currentState = await getScrapingState();

    // Stopped or errored: nothing to resume — but clear any stale persisted
    // deadline so a later wake doesn't treat it as a missed schedule.
    if (!currentState.isActive) {
      if (currentState.nextScrapeAt !== null) {
        currentState.nextScrapeAt = null;
        await saveScrapingState(currentState);
        await chrome.alarms.clear(NEXT_PAGE_ALARM);
      }
      return;
    }

    // Already resumed by the racing trigger (alarm vs short-delay timer) — no-op.
    if (currentState.nextScrapeAt === null) return;

    await chrome.alarms.clear(NEXT_PAGE_ALARM);

    const tabId = currentState.scrapingTabId;
    currentState.nextScrapeAt = null;
    await saveScrapingState(currentState);

    if (!tabId) {
      console.error('[BACKGROUND] Cannot resume next page: no scraping tab in state');
      await haltRun('error', 'Scraping tab reference was lost. Start again from the Sales Navigator page.');
      return;
    }

    try {
      await chrome.tabs.get(tabId);
    } catch {
      console.log(`[BACKGROUND] Cannot resume next page: tab ${tabId} no longer exists`);
      await haltRun('tab_lost', 'The Sales Navigator tab was closed. Scraping stopped.');
      return;
    }

    try {
      await ensureContentScriptInjected(tabId);
    } catch (err: any) {
      await haltRun('error', `Could not reach the scraper on the page: ${err?.message || err}`);
      return;
    }

    // START_SCRAPING re-arms the content-script flag in case the page reloaded
    // and a fresh instance was injected (idempotent if already active).
    await sendToScrapingTab('START_SCRAPING');
    await new Promise(resolve => setTimeout(resolve, 100));
    await sendToScrapingTab('SCRAPE_PAGE', { page: currentState.currentPage });
  } finally {
    resumeNextPageInFlight = false;
  }
}

/**
 * Stop the run hard: clear alarms/state, package + submit whatever was scraped,
 * and surface the error to the popup. This is the SINGLE halt implementation —
 * handleScrapingError and the watchdog delegate here.
 *
 * @param errorMessage  null = don't sendError (the popup already received the
 *                      error directly, e.g. from the content script)
 * @param opts.notifyTab false = skip STOP_SCRAPING to the tab (e.g. the content
 *                      script itself errored and is no longer scraping)
 */
async function haltRun(
  endReason: PushSession['endReason'],
  errorMessage: string | null,
  { notifyTab = true }: { notifyTab?: boolean } = {},
): Promise<void> {
  await chrome.alarms.clear(AUTO_RESUME_ALARM);
  await chrome.alarms.clear(NEXT_PAGE_ALARM);
  await chrome.alarms.clear(WATCHDOG_ALARM);
  currentState.isActive = false;
  currentState.cooldownUntil = null;
  currentState.resumeTabId = null;
  currentState.nextScrapeAt = null;
  if (notifyTab) await sendToScrapingTab('STOP_SCRAPING');
  currentState.scrapingTabId = null;
  await saveScrapingState(currentState);
  broadcastStateUpdate(currentState);
  // Whatever was scraped before the failure is still worth enriching.
  await endRunSession(endReason);
  if (errorMessage !== null) sendError({ message: errorMessage });
}

/**
 * Repeating stall detector: while a run is active with no inter-page delay and
 * no cooldown pending, PAGE_COMPLETE progress must arrive within
 * STALL_TIMEOUT_MS — otherwise something silently died (tab navigated away,
 * content script wedged, lost message) and the run would hang forever.
 */
async function watchdogCheck(): Promise<void> {
  currentState = await getScrapingState();

  if (!currentState.isActive) {
    // Run ended via a path that leaves the watchdog armed — self-clear.
    await chrome.alarms.clear(WATCHDOG_ALARM);
    return;
  }
  if (currentState.nextScrapeAt !== null) return;  // inter-page delay pending
  if (currentState.cooldownUntil !== null) return; // cooldown pending

  if (currentState.lastProgressAt === null) {
    // State persisted by an older version without the field — start the clock now.
    currentState.lastProgressAt = Date.now();
    await saveScrapingState(currentState);
    return;
  }

  if (Date.now() - currentState.lastProgressAt > STALL_TIMEOUT_MS) {
    console.error('[BACKGROUND] Watchdog: run stalled, halting');
    await haltRun('error', 'Run stalled — no progress for 5 minutes. Scraping stopped.');
  }
}

/**
 * Handle per-page completion (PAGE_COMPLETE) from the content script.
 * The inter-page delay lives here, not in the content script.
 */
async function handlePageComplete(data: { scrapedCount: number; hasNextPage: boolean }, senderTabId?: number) {
  // Guard: ignore PAGE_COMPLETE from tabs that aren't the scraping tab
  if (currentState.scrapingTabId && senderTabId && senderTabId !== currentState.scrapingTabId) {
    console.log(`[BACKGROUND] Ignoring PAGE_COMPLETE from non-scraping tab ${senderTabId}`);
    return;
  }

  // Guard: ignore completions when no run is active (e.g. late message after Stop)
  if (!currentState.isActive) {
    console.log('[BACKGROUND] Ignoring PAGE_COMPLETE: no active run');
    return;
  }

  // Guard: ignore duplicate PAGE_COMPLETE for the same page (lastCompletedPage
  // is persisted, so this survives SW restarts mid-run)
  if (currentState.currentPage <= currentState.lastCompletedPage) {
    console.log(`[BACKGROUND] Ignoring duplicate PAGE_COMPLETE for page ${currentState.currentPage}`);
    return;
  }

  currentState.lastCompletedPage = currentState.currentPage;
  console.log(`[BACKGROUND] Page ${currentState.currentPage} complete. Scraped: ${data.scrapedCount}, hasNextPage: ${data.hasNextPage}`);

  currentState.totalScraped += data.scrapedCount;
  currentState.sessionPageCount += 1;
  currentState.lastProgressAt = Date.now(); // feeds the stall watchdog
  await saveScrapingState(currentState);
  await recordPageScraped(currentState.lastCompletedPage, data.scrapedCount);

  if (data.scrapedCount > 0) {
    await incrementDailyCount(data.scrapedCount);
  }

  // Per-run page target: treat reaching it as "no next page" so the completion
  // path runs cleanly.
  let hasNextPage = data.hasNextPage;
  if (hasNextPage && currentState.targetPageCount && currentState.lastCompletedPage >= currentState.targetPageCount) {
    console.log(`[BACKGROUND] Target page count reached (${currentState.lastCompletedPage}/${currentState.targetPageCount}), stopping`);
    hasNextPage = false;
  }

  if (hasNextPage && currentState.isActive) {
    const settings = await getSettings();

    // --- Safety check: daily limit ---
    if (await isDailyLimitReached(settings.dailyLimit)) {
      console.log(`[BACKGROUND] Daily limit reached (${settings.dailyLimit}), stopping scraping`);
      currentState.isActive = false;
      await sendToScrapingTab('STOP_SCRAPING');
      currentState.scrapingTabId = null;
      await saveScrapingState(currentState);
      broadcastStateUpdate(currentState);
      await endRunSession('daily_limit');
      sendError({ message: `Daily limit reached (${settings.dailyLimit} profiles). Scraping stopped.` });
      return;
    }

    // --- Safety check: pages per session ---
    if (currentState.sessionPageCount >= settings.pagesPerSession) {
      const jitterMinutes = settings.cooldownMinutes * 0.4 * Math.random();
      const cooldownMs = (settings.cooldownMinutes + jitterMinutes) * 60000;
      currentState.cooldownUntil = Date.now() + cooldownMs;

      const willAutoResume = settings.autoResumeAfterCooldown;
      console.log(`[BACKGROUND] Session limit reached (${settings.pagesPerSession} pages), cooldown ${Math.round(cooldownMs / 60000)}m, autoResume=${willAutoResume}`);

      currentState.isActive = false;
      await sendToScrapingTab('STOP_SCRAPING');

      // Preserve tab for auto-resume before nulling scrapingTabId. Persist in
      // state (not module memory) so the alarm can find the tab after a SW restart.
      if (willAutoResume) {
        currentState.resumeTabId = currentState.scrapingTabId;
        await chrome.alarms.create(AUTO_RESUME_ALARM, { when: Date.now() + cooldownMs });
        currentState.scrapingTabId = null;
        await saveScrapingState(currentState);
        broadcastStateUpdate(currentState);
      } else {
        // No auto-resume — this is the end of the run. Package what we have.
        currentState.scrapingTabId = null;
        await saveScrapingState(currentState);
        broadcastStateUpdate(currentState);
        await endRunSession('cooldown_no_resume');
      }
      return;
    }

    // Move to next page
    currentState.currentPage += 1;
    await saveScrapingState(currentState);
    broadcastStateUpdate(currentState);

    // Compute the full pre-page delay up front, then schedule it via
    // chrome.alarms (NEVER awaited in-process — the combined delay routinely
    // exceeds the ~30s MV3 SW idle kill and a dead SW would silently abandon
    // the run).
    let delayMs = getGaussianDelayMs(settings.minDelay * 1000, settings.maxDelay * 1000);

    // --- Distraction pause: every 5-10 pages, add a 30-90s "reading pause" ---
    const pauseInterval = 5 + Math.floor(Math.random() * 6); // 5-10
    if (currentState.sessionPageCount > 0 && currentState.sessionPageCount % pauseInterval === 0) {
      delayMs += getGaussianDelayMs(30000, 90000);
    }

    // --- 10% chance: add a 15-30s "long dwell" ---
    if (Math.random() < 0.10) {
      delayMs += getGaussianDelayMs(15000, 30000);
    }

    // A Stop can interleave the awaits above (handleStopScraping mutates the
    // same module-level state within this SW life) — re-check right before
    // arming the schedule so a stopped run isn't re-armed.
    if (!currentState.isActive) {
      console.log('[BACKGROUND] Run stopped while computing delay, not scheduling next page');
      return;
    }

    await scheduleNextPage(delayMs);
  } else {
    // Scraping complete
    console.log('[BACKGROUND] Scraping complete - no more pages or scraping stopped');
    currentState.isActive = false;
    currentState.scrapingTabId = null;
    await saveScrapingState(currentState);
    broadcastStateUpdate(currentState);

    const totalScraped = currentState.totalScraped;
    await endRunSession('completed');

    // End-of-run completion message — SCRAPING_COMPLETE is sent ONLY here
    // (per-page completions use PAGE_COMPLETE).
    chrome.runtime.sendMessage({
      action: 'SCRAPING_COMPLETE',
      data: { totalScraped },
    }).catch(() => {
      // Popup might not be open
    });
  }
}

/**
 * Handle error from content script.
 * NOTE: the popup already received the content script's SCRAPING_ERROR directly
 * (runtime.sendMessage broadcasts to every extension context), so this must NOT
 * re-broadcast it — that would double the popup's error log.
 */
async function handleScrapingError(error: { message: string; details?: string }) {
  console.error('Handling scraping error:', error.message);
  await haltRun('error', null, { notifyTab: false });
}

function handleSelectorDegraded(data: { tier3Count: number; consecutivePages: number }) {
  degradedSelectorCount = data.consecutivePages;
  if (degradedSelectorCount >= 3) {
    console.warn(`[BACKGROUND] Selector degradation: ${degradedSelectorCount} consecutive pages using tier 3 fallback`);
    refreshBadge().catch(() => {});
  }
}

/** Popup asks for the current run. */
async function handleGetRun(): Promise<{ run: RunSummary | null; hasScraped: boolean; companyCount: number }> {
  const [state, scraped, companies] = await Promise.all([
    getRunState(),
    getScrapedProfiles(),
    getScrapedCompanies(),
  ]);
  return { run: summarize(state), hasScraped: scraped.length > 0, companyCount: companies.length };
}

/** Manual start, for auto-enrich off or a failed automatic start. */
async function handleStartEnrichment() {
  if (currentState.isActive) {
    return { success: false, error: 'Stop the scraping run before enriching.' };
  }
  // A run in cooldown is PAUSED, not finished — more pages are still coming.
  if (currentState.cooldownUntil !== null || currentState.resumeTabId !== null) {
    return {
      success: false,
      error: 'This scrape is in cooldown and will resume. Press Stop first to enrich what you have.',
    };
  }
  const session = await getPushSession();
  const result = await startEnrichment(session ?? null);
  if (result.success) await clearPushSession();
  return result;
}

/** Stop mid-run. Everything enriched so far is kept and still exportable. */
async function handleStopEnrichment() {
  const state = await getRunState();
  if (!state) return { success: false, error: 'No run to stop.' };
  state.phase = 'stopped';
  state.finishedAt = new Date().toISOString();
  await saveRunState(state);
  await chrome.alarms.clear(ENRICH_TICK_ALARM);
  await broadcastRunState(state);
  return { success: true };
}

/** Score a finished run again, reusing the enrichment already paid for. */
async function handleRescoreRun() {
  const state = await getRunState();
  if (!state) return { success: false, error: 'No run to re-score.' };
  if (summarize(state)?.active) return { success: false, error: 'This run is still going.' };
  if (state.enriched.length === 0) return { success: false, error: 'Nothing enriched to score.' };

  resetScoring(state, Date.now());
  await saveRunState(state);
  await chrome.alarms.create(ENRICH_TICK_ALARM, {
    delayInMinutes: ENRICH_TICK_MINUTES,
    periodInMinutes: ENRICH_TICK_MINUTES,
  });
  await broadcastRunState(state);

  console.log(`[BACKGROUND] Re-scoring ${state.enriched.length} contacts`);
  driveRun().catch((err) => console.error('[BACKGROUND] driveRun failed:', err));
  return { success: true };
}

/** Clear a finished run so the next scrape starts clean. */
async function handleDiscardRun() {
  await clearRunState();
  await chrome.alarms.clear(ENRICH_TICK_ALARM);
  await broadcastRunState(null);
  return { success: true };
}

// ─── Message handling ───

// Dispatch an async handler and guarantee sendResponse fires — on success OR
// rejection. Without the .catch, an unhandled rejection leaves the popup hung
// until Chrome times out the channel, masking the real error.
function dispatchAsync<T>(
  promise: Promise<T>,
  sendResponse: (response?: any) => void,
  action: string,
  successWrapper?: (v: T) => any,
): void {
  promise
    .then((value) => sendResponse(successWrapper ? successWrapper(value) : value))
    .catch((err: any) => {
      const msg = err?.message || String(err);
      console.error(`[BACKGROUND] ${action} handler rejected:`, msg, err);
      sendResponse({ success: false, error: msg });
    });
}

onMessage((message: Message, sender, sendResponse) => {
  // Every handler awaits initialization first: the SW may have just woken up
  // for this very message, and acting on the stale module-level currentState
  // would serve wrong status to the popup or discard legitimate completions.
  switch (message.action) {
    case 'START_SCRAPING':
      dispatchAsync(ensureInitialized().then(() => handleStartScraping(message.data)), sendResponse, 'START_SCRAPING');
      return true;

    case 'STOP_SCRAPING':
      dispatchAsync(ensureInitialized().then(() => handleStopScraping()), sendResponse, 'STOP_SCRAPING');
      return true;

    case 'SCRAPING_STATUS':
      dispatchAsync(ensureInitialized().then(() => handleGetStatus()), sendResponse, 'SCRAPING_STATUS');
      return true;

    case 'PAGE_COMPLETE':
      dispatchAsync(
        ensureInitialized().then(() => handlePageComplete(message.data, sender.tab?.id)),
        sendResponse,
        'PAGE_COMPLETE',
        () => ({ success: true }),
      );
      return true;

    case 'SCRAPING_ERROR':
      dispatchAsync(
        ensureInitialized().then(() => handleScrapingError(message.data)),
        sendResponse,
        'SCRAPING_ERROR',
        () => ({ success: true }),
      );
      return true;

    case 'SELECTOR_DEGRADED':
      handleSelectorDegraded(message.data);
      sendResponse({ success: true });
      return;

    case 'GET_RUN':
      dispatchAsync(ensureInitialized().then(() => handleGetRun()), sendResponse, 'GET_RUN');
      return true;

    case 'START_ENRICHMENT':
      dispatchAsync(
        ensureInitialized().then(() => handleStartEnrichment()),
        sendResponse,
        'START_ENRICHMENT',
      );
      return true;

    case 'STOP_ENRICHMENT':
      dispatchAsync(
        ensureInitialized().then(() => handleStopEnrichment()),
        sendResponse,
        'STOP_ENRICHMENT',
      );
      return true;

    case 'RESCORE_RUN':
      dispatchAsync(ensureInitialized().then(() => handleRescoreRun()), sendResponse, 'RESCORE_RUN');
      return true;

    case 'DISCARD_RUN':
      dispatchAsync(ensureInitialized().then(() => handleDiscardRun()), sendResponse, 'DISCARD_RUN');
      return true;

    case 'LOG_MESSAGE':
      // Content-script logs reach the popup DIRECTLY via runtime.sendMessage —
      // re-broadcasting them here would double every popup log line. Just ack.
      sendResponse({ success: true });
      return;

    default:
      console.warn('Unknown message action:', message.action);
      sendResponse({ error: 'Unknown action' });
  }
});

// Register alarm listener at top level so it survives SW restarts.
chrome.alarms.onAlarm.addListener((alarm) => {
  ensureInitialized()
    .then(() => {
      if (alarm.name === AUTO_RESUME_ALARM) return autoResume();
      if (alarm.name === NEXT_PAGE_ALARM) return resumeNextPage();
      if (alarm.name === WATCHDOG_ALARM) return watchdogCheck();
      if (alarm.name === ENRICH_TICK_ALARM) return driveRun();
    })
    .catch((err) => {
      console.error(`[BACKGROUND] Alarm handler failed (${alarm.name}):`, err);
    });
});

// A run only truly dies when its content scripts are orphaned: extension
// reload/update or browser restart. Reset state there — NOT on every SW wake,
// which would abandon healthy runs mid-delay.
chrome.runtime.onInstalled.addListener(() => {
  // Set SYNCHRONOUSLY (before any await) so initialize()'s missed-deadline
  // branch can't ghost-resume the run this reset is about to finalize.
  hardResetPending = true;
  hardResetOnReload('extension installed/updated').catch((err) => {
    console.error('[BACKGROUND] Hard reset failed:', err);
  });
});

chrome.runtime.onStartup.addListener(() => {
  hardResetPending = true;
  hardResetOnReload('browser startup').catch((err) => {
    console.error('[BACKGROUND] Hard reset failed:', err);
  });
});

// Initialize on every SW wake
ensureInitialized().catch((err) => {
  console.error('[BACKGROUND] Initialization failed:', err);
});
