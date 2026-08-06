/**
 * The enrichment run, orchestrated in the extension.
 *
 * This is the work the Cloudflare Workflow used to do. It moved here because
 * the Workers free plan allows 50 subrequests and 10ms CPU per invocation,
 * and a 1000-contact run needs ~4,300 subrequests and ~500ms of CPU. The
 * browser has neither limit; the worker keeps the credentials.
 *
 * Resumability replaces durability. An MV3 service worker is killed after ~30s
 * idle, so EVERY chunk boundary persists a cursor to chrome.storage. A tick
 * that dies mid-run is resumed by an alarm from exactly where it stopped —
 * nothing already paid for is ever re-fetched.
 *
 * Phases, in order:
 *   A. enrich people    LinkedIn profile only — no activity is fetched
 *   B. enrich companies deduped, so 1000 contacts at 300 employers costs 300
 *   C. contacts         emails and phones, 25 profile URLs per proxied call
 *   D. score            one proxied LLM call per contact
 * The workbook is built lazily by the popup from the finished state.
 */

import { HarvestClient, pool } from './harvest';
import { CONTACTS_BATCH_SIZE, contactKey, fetchContacts } from './contacts';
import type { ContactInfo } from './contacts';
import { enrichContact } from './enrich';
import { buildDossier } from './dossier';
import { scoreDossier, isFatalScoringError } from './score';
import type {
  EnrichedContact,
  HarvestCompany,
  InboundContact,
  ScoredContact,
} from './harvest-types';

export type RunPhase =
  | 'enriching'
  | 'companies'
  | 'contacts'
  | 'scoring'
  | 'complete'
  | 'error'
  | 'stopped';

/** Knobs served by the worker's GET /config. */
export interface RunConfig {
  icp: string;
  model: string;
  harvestConcurrency: number;
  findEmail: boolean;
  companyNameFallback: boolean;
  maxContactsPerRun: number;
  /** Worker has a Similarweb key — run phase C. Older workers omit it. */
  findContacts?: boolean;
}

/**
 * The entire run, persisted after every chunk. Deliberately plain JSON — it
 * has to survive a service-worker death and a browser restart.
 */
export interface RunState {
  localId: string;
  /** The worker's run id, for the usage record. Null if /runs failed. */
  runId: string | null;
  label: string;
  /** Per-run ICP override, or '' to use the worker's. */
  icp: string;
  phase: RunPhase;
  contacts: InboundContact[];
  /** Index of the next contact to enrich. */
  enrichCursor: number;
  /** Index of the next contact to score. */
  scoreCursor: number;
  enriched: EnrichedContact[];
  /** Namespaced cache key -> company. */
  companies: Record<string, HarvestCompany>;
  /** Company lookups still to do, resolved once phase A finishes. */
  companyQueue: { mode: 'slug' | 'name'; value: string }[];
  companyCursor: number;
  /**
   * Similarweb result per enriched contact, aligned to `enriched` by index.
   * Optional: runs persisted before phase C existed resume without it.
   */
  contactInfo?: (ContactInfo | null)[];
  contactCursor?: number;
  scores: { score: ScoredContact['score']; scoreError: string | null }[];
  totals: {
    harvestCalls: number;
    llmCalls: number;
    llmTokensIn: number;
    llmTokensOut: number;
  };
  startedAt: string;
  finishedAt: string | null;
  /** Epoch ms of the last persisted progress — feeds the stall watchdog. */
  lastProgressAt: number;
  error: string | null;
  /** Deterministic clock (tenure, workbook stamp), fixed at run start. */
  now: number;
}

/** Namespaced so a slug and a display name can never collide in the cache. */
export function companyCacheKey(mode: 'slug' | 'name', value: string): string {
  return `${mode}:${value.toLowerCase()}`;
}

export function createRunState(
  contacts: InboundContact[],
  options: { label: string; icp: string; now: number },
): RunState {
  return {
    localId: crypto.randomUUID(),
    runId: null,
    label: options.label || 'salesnav',
    icp: options.icp || '',
    phase: 'enriching',
    contacts,
    enrichCursor: 0,
    scoreCursor: 0,
    enriched: [],
    companies: {},
    companyQueue: [],
    companyCursor: 0,
    contactInfo: [],
    contactCursor: 0,
    scores: [],
    totals: { harvestCalls: 0, llmCalls: 0, llmTokensIn: 0, llmTokensOut: 0 },
    startedAt: new Date(options.now).toISOString(),
    finishedAt: null,
    lastProgressAt: options.now,
    error: null,
    now: options.now,
  };
}

/**
 * Rewind a finished run to the start of phase C so it scores again.
 *
 * The expensive half of a run is HarvestAPI, and `enriched` already holds it —
 * a rescore after a model or ICP change costs one LLM call per contact and not
 * one profile call. Every contact is redone rather than just the failures: a
 * sheet mixing two models down one score column is not comparable.
 */
export function resetScoring(state: RunState, now: number): void {
  state.scores = [];
  state.scoreCursor = 0;
  state.phase = 'scoring';
  state.error = null;
  state.finishedAt = null;
  state.lastProgressAt = now;
}

/** Contacts finished, for the progress bar. */
export function runProgress(state: RunState): { done: number; total: number; label: string } {
  const total = state.contacts.length;
  switch (state.phase) {
    case 'enriching':
      return { done: state.enrichCursor, total, label: 'Enriching profiles' };
    case 'companies':
      return {
        done: state.companyCursor,
        total: state.companyQueue.length,
        label: 'Looking up companies',
      };
    case 'contacts':
      return {
        done: state.contactCursor ?? 0,
        total: state.enriched.length,
        label: 'Finding emails and phones',
      };
    case 'scoring':
      return { done: state.scoreCursor, total, label: 'Scoring against ICP' };
    case 'complete':
      return { done: total, total, label: 'Complete' };
    case 'stopped':
      return { done: state.scoreCursor, total, label: 'Stopped' };
    default:
      return { done: state.scoreCursor, total, label: 'Failed' };
  }
}

export interface StepContext {
  workerUrl: string;
  apiToken: string;
  config: RunConfig;
  /** Persist the state. Called at every chunk boundary. */
  save: (state: RunState) => Promise<void>;
  /** Return true to stop early (user pressed Stop). */
  shouldStop: () => Promise<boolean>;
}

/**
 * Advance the run by ONE chunk and persist.
 *
 * Returns true when there is more to do. The caller loops on it, which keeps
 * the service worker alive through the in-flight fetches, and an alarm calls it
 * again if the worker was killed between chunks.
 */
export async function advanceRun(state: RunState, ctx: StepContext): Promise<boolean> {
  if (state.phase === 'complete' || state.phase === 'error' || state.phase === 'stopped') {
    return false;
  }

  if (await ctx.shouldStop()) {
    state.phase = 'stopped';
    state.finishedAt = new Date().toISOString();
    await ctx.save(state);
    return false;
  }

  const chunkSize = Math.max(1, Math.min(ctx.config.harvestConcurrency, 10));

  // ─── Phase A: people ───
  if (state.phase === 'enriching') {
    const batch = state.contacts.slice(state.enrichCursor, state.enrichCursor + chunkSize);
    if (batch.length === 0) {
      state.companyQueue = buildCompanyQueue(state, ctx.config.companyNameFallback);
      state.phase = 'companies';
      await ctx.save(state);
      return true;
    }

    const results = await pool(
      batch.map((contact) => () =>
        enrichContact(contact, {
          workerUrl: ctx.workerUrl,
          apiToken: ctx.apiToken,
          findEmail: ctx.config.findEmail,
        }),
      ),
      ctx.config.harvestConcurrency,
    );

    state.enriched.push(...results);
    state.enrichCursor += batch.length;
    state.totals.harvestCalls += results.reduce((sum, r) => sum + r.harvestCalls, 0);
    state.lastProgressAt = Date.now();

    // A token that has gone bad fails identically for every contact. Stop
    // rather than grinding through 995 more identical failures.
    const authFailure = results
      .flatMap((r) => r.errors)
      .find((e) => /HTTP 401|HTTP 403|unauthorized|daily .* limit/i.test(e));
    if (authFailure) {
      state.phase = 'error';
      state.error = authFailure;
      state.finishedAt = new Date().toISOString();
    }

    await ctx.save(state);
    return state.phase === 'enriching';
  }

  // ─── Phase B: companies (deduped) ───
  if (state.phase === 'companies') {
    const batch = state.companyQueue.slice(state.companyCursor, state.companyCursor + chunkSize);
    if (batch.length === 0) {
      state.phase = ctx.config.findContacts ? 'contacts' : 'scoring';
      await ctx.save(state);
      return true;
    }

    const client = new HarvestClient({ workerUrl: ctx.workerUrl, apiToken: ctx.apiToken });
    const found = await pool(
      batch.map((entry) => async () => {
        try {
          const company =
            entry.mode === 'slug'
              ? await client.getCompany(entry.value)
              : await client.searchCompany(entry.value);
          return { key: companyCacheKey(entry.mode, entry.value), company };
        } catch {
          // A company miss degrades the row; it does not fail the run.
          return { key: companyCacheKey(entry.mode, entry.value), company: null };
        }
      }),
      ctx.config.harvestConcurrency,
    );

    for (const entry of found) {
      if (entry.company) state.companies[entry.key] = entry.company;
    }
    state.companyCursor += batch.length;
    state.totals.harvestCalls += client.calls;
    state.lastProgressAt = Date.now();
    await ctx.save(state);
    return true;
  }

  // ─── Phase C: contacts (emails and phones) ───
  if (state.phase === 'contacts') {
    // Both fields are optional on RunState so a run persisted by an older
    // build resumes here instead of throwing on an undefined array.
    state.contactInfo ??= [];
    state.contactCursor ??= 0;

    const cursor = state.contactCursor;
    const batch = state.enriched.slice(cursor, cursor + CONTACTS_BATCH_SIZE);
    if (batch.length === 0) {
      state.phase = 'scoring';
      await ctx.save(state);
      return true;
    }

    // Only the public profile URL is a safe join key, so a contact whose
    // profile lookup failed gets no lookup at all rather than a name match
    // that could attach a stranger's phone number to the row.
    const urls = batch.map((contact) => contact.profile?.linkedinUrl ?? '');

    let found = new Map<string, ContactInfo>();
    let authFailure: string | null = null;
    try {
      found = await fetchContacts(urls.filter(Boolean), {
        workerUrl: ctx.workerUrl,
        apiToken: ctx.apiToken,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A bad token or an exhausted daily limit fails every remaining batch
      // identically; anything else just leaves these 25 rows blank.
      if (/HTTP 401|HTTP 403|HTTP 429/.test(message)) authFailure = message;
      else console.warn('[enrichment] contact lookup failed:', message);
    }

    for (const url of urls) {
      state.contactInfo.push(url ? (found.get(contactKey(url)) ?? null) : null);
    }
    state.contactCursor = cursor + batch.length;
    state.lastProgressAt = Date.now();

    if (authFailure) {
      // Enrichment so far is paid for and kept: fall through to scoring rather
      // than ending the run, and the workbook just has blank contact columns.
      console.warn('[enrichment] contact lookups disabled for this run:', authFailure);
      for (let index = state.contactCursor; index < state.enriched.length; index++) {
        state.contactInfo.push(null);
      }
      state.contactCursor = state.enriched.length;
    }

    await ctx.save(state);
    return true;
  }

  // ─── Phase D: scoring ───
  const batch = state.enriched.slice(state.scoreCursor, state.scoreCursor + chunkSize);
  if (batch.length === 0) {
    state.phase = 'complete';
    state.finishedAt = new Date().toISOString();
    await ctx.save(state);
    return false;
  }

  const results = await pool(
    batch.map((contact) => async () => {
      const company = companyFor(state, contact);
      const result = await scoreDossier(buildDossier(contact, company), {
        workerUrl: ctx.workerUrl,
        apiToken: ctx.apiToken,
        icp: state.icp || undefined,
      });
      return result;
    }),
    Math.max(1, Math.min(ctx.config.harvestConcurrency, 5)),
  );

  for (const result of results) {
    state.scores.push({ score: result.score, scoreError: result.error });
    state.totals.llmCalls += result.usage.calls;
    state.totals.llmTokensIn += result.usage.tokensIn;
    state.totals.llmTokensOut += result.usage.tokensOut;
  }
  state.scoreCursor += batch.length;
  state.lastProgressAt = Date.now();

  const fatal = results.map((r) => r.error).find(isFatalScoringError);
  if (fatal) {
    // Enrichment is already paid for and kept — the run ends usable, just
    // partially scored, and the workbook still exports every row.
    state.phase = 'error';
    state.error = fatal;
    state.finishedAt = new Date().toISOString();
  }

  await ctx.save(state);
  return state.phase === 'scoring';
}

/** The distinct company lookups this run needs, in a stable order. */
function buildCompanyQueue(
  state: RunState,
  nameFallback: boolean,
): { mode: 'slug' | 'name'; value: string }[] {
  const bySlug = new Map<string, string>();
  const byName = new Map<string, string>();

  for (const contact of state.enriched) {
    if (contact.companyKey) {
      bySlug.set(contact.companyKey.toLowerCase(), contact.companyKey);
      continue;
    }
    const name = (contact.input.company ?? '').trim();
    if (nameFallback && name) byName.set(name.toLowerCase(), name);
  }

  return [
    ...[...bySlug.values()].map((value) => ({ mode: 'slug' as const, value })),
    ...[...byName.values()].map((value) => ({ mode: 'name' as const, value })),
  ];
}

export function companyFor(state: RunState, contact: EnrichedContact): HarvestCompany | null {
  if (contact.companyKey) {
    return state.companies[companyCacheKey('slug', contact.companyKey)] ?? null;
  }
  const name = (contact.input.company ?? '').trim();
  if (!name) return null;
  return state.companies[companyCacheKey('name', name)] ?? null;
}

/**
 * Zip the run's parts into the rows the workbook wants. Contacts enriched but
 * not yet scored still appear — a partially-scored run is worth exporting.
 */
export function collectScoredContacts(state: RunState): ScoredContact[] {
  return state.enriched.map((enriched, index) => ({
    enriched,
    company: companyFor(state, enriched),
    contact: state.contactInfo?.[index] ?? null,
    score: state.scores[index]?.score ?? null,
    scoreError:
      state.scores[index]?.scoreError ??
      (index >= state.scoreCursor ? 'not scored — run ended early' : null),
  }));
}
