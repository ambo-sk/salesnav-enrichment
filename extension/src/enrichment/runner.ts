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
 *   A. enrich people    profile + 6mo posts/comments (+ reactions)
 *   B. enrich companies deduped, so 1000 contacts at 300 employers costs 300
 *   C. score            one proxied LLM call per contact
 * The workbook is built lazily by the popup from the finished state.
 */

import { HarvestClient, pool } from './harvest';
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
  | 'scoring'
  | 'complete'
  | 'error'
  | 'stopped';

/** Knobs served by the worker's GET /config. */
export interface RunConfig {
  icp: string;
  model: string;
  harvestConcurrency: number;
  maxPostPages: number;
  maxCommentPages: number;
  maxReactionPages: number;
  includeReactions: boolean;
  findEmail: boolean;
  companyNameFallback: boolean;
  maxContactsPerRun: number;
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
  /** Deterministic clock for the 6-month window, fixed at run start. */
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
    scores: [],
    totals: { harvestCalls: 0, llmCalls: 0, llmTokensIn: 0, llmTokensOut: 0 },
    startedAt: new Date(options.now).toISOString(),
    finishedAt: null,
    lastProgressAt: options.now,
    error: null,
    now: options.now,
  };
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
          maxPostPages: ctx.config.maxPostPages,
          maxCommentPages: ctx.config.maxCommentPages,
          maxReactionPages: ctx.config.maxReactionPages,
          includeReactions: ctx.config.includeReactions,
          findEmail: ctx.config.findEmail,
          now: state.now,
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
      state.phase = 'scoring';
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

  // ─── Phase C: scoring ───
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

function companyFor(state: RunState, contact: EnrichedContact): HarvestCompany | null {
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
    score: state.scores[index]?.score ?? null,
    scoreError:
      state.scores[index]?.scoreError ??
      (index >= state.scoreCursor ? 'not scored — run ended early' : null),
  }));
}
