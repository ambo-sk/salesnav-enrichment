/**
 * Enrichment proxy worker.
 *
 *   GET  /health              unauthenticated liveness probe
 *   GET  /config              ICP, model and pipeline knobs for the extension
 *   POST /proxy/harvest       {path, params} -> HarvestAPI, key attached here
 *   POST /proxy/score         {dossier} -> Score, prompt + ICP + model applied here
 *   POST /proxy/contacts      {contacts} -> Similarweb emails + phones, key attached here
 *   POST /runs                start a run, returns its id
 *   POST /runs/:id/finish     record totals
 *   GET  /runs                this user's recent runs
 *
 * Why a proxy and not a Workflow: the Workers free plan allows 50 subrequests
 * per invocation and 10ms CPU per invocation. A 1000-contact enrichment needs
 * ~4,300 subrequests and ~500ms of CPU to build the workbook — impossible
 * inside one instance. As one invocation per upstream call, each request uses a
 * single subrequest and near-zero CPU, so the whole pipeline fits the free
 * plan. The extension orchestrates and builds the workbook locally.
 *
 * What this buys, and what it costs: the HarvestAPI and OpenRouter keys never
 * reach the browser, and every call is metered per user. In exchange the run
 * only progresses while the browser is open.
 */

import { authenticate, checkAndRecordUsage, createRun, finishRun, listRuns } from './db';
import { scoreDossier } from './openrouter';
import { SOKIN_ICP, icpText } from './icp';
import type { AuthedUser, ClientConfig, Env } from './types';

const HARVEST_BASE = 'https://api.harvestapi.io';
const SIMILARWEB_CONTACTS_URL = 'https://api.similarweb.com/v5/contact-enrichment/contacts/bulk';

/**
 * Similarweb bills per returned field: mobile phone 20 data credits, email 4,
 * direct phone 1. The list is fixed HERE, not sent by the extension — a token
 * holder must not be able to turn a run into a 20-credit-per-row mobile sweep.
 */
const SIMILARWEB_OUTPUT_FIELDS = [
  'contact_id',
  'linkedin_url',
  'emails',
  'direct_phones',
  'mobile_phones',
  'accuracy_score',
  'direct_phone_do_not_call',
  'mobile_phone_do_not_call',
];

/** Similarweb's own per-request ceiling on the bulk endpoint. */
const MAX_CONTACTS_PER_LOOKUP = 25;

/**
 * Only these upstream paths are reachable through the proxy. Without an
 * allowlist a token holder could point the worker at any HarvestAPI endpoint,
 * including ones that send connection requests or messages as the account.
 */
const ALLOWED_HARVEST_PATHS = new Set(['/linkedin/profile', '/linkedin/company']);

/** Per-request guard rails on proxied query parameters. */
const MAX_PARAM_LENGTH = 500;
const MAX_PARAMS = 12;
const MAX_DOSSIER_CHARS = 60000;

// ─── CORS ───

function corsHeaders(env: Env, request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '';
  const allowed = (env.ALLOWED_ORIGINS ?? '*')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  const allowOrigin =
    allowed.includes('*') || allowed.length === 0
      ? origin || '*'
      : allowed.includes(origin)
        ? origin
        : '';

  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (allowOrigin) headers['Access-Control-Allow-Origin'] = allowOrigin;
  return headers;
}

function json(data: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

function intVar(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function boolVar(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function configFor(env: Env): ClientConfig {
  return {
    icp: env.DEFAULT_ICP?.trim() || SOKIN_ICP,
    model: env.OPENROUTER_MODEL,
    harvestConcurrency: Math.max(1, Math.min(intVar(env.HARVEST_CONCURRENCY, 5), 40)),
    findEmail: boolVar(env.FIND_EMAIL, false),
    companyNameFallback: boolVar(env.COMPANY_NAME_FALLBACK, true),
    maxContactsPerRun: intVar(env.MAX_CONTACTS_PER_JOB, 1000),
    findContacts: Boolean(env.SIMILARWEB_API_KEY),
  };
}

// ─── Proxy handlers ───

async function handleHarvestProxy(
  request: Request,
  env: Env,
  user: AuthedUser,
  cors: Record<string, string>,
): Promise<Response> {
  let body: { path?: unknown; params?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: 'invalid JSON body' }, 400, cors);
  }

  const path = typeof body.path === 'string' ? body.path : '';
  if (!ALLOWED_HARVEST_PATHS.has(path)) {
    return json({ error: `path not allowed: ${path}` }, 403, cors);
  }

  const params = (body.params ?? {}) as Record<string, unknown>;
  const entries = Object.entries(params);
  if (entries.length > MAX_PARAMS) {
    return json({ error: 'too many parameters' }, 400, cors);
  }

  const url = new URL(path, HARVEST_BASE);
  for (const [key, value] of entries) {
    if (typeof value !== 'string' || value.length > MAX_PARAM_LENGTH) continue;
    url.searchParams.set(key, value);
  }

  const allowed = await checkAndRecordUsage(env, user.id, 'harvest', {
    limit: intVar(env.DAILY_HARVEST_CALL_LIMIT, 20000),
  });
  if (!allowed) {
    return json({ error: 'daily HarvestAPI call limit reached for this token' }, 429, cors);
  }

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      headers: { 'X-API-Key': env.HARVEST_API_KEY, Accept: 'application/json' },
    });
  } catch (err) {
    return json(
      { error: `upstream unreachable: ${err instanceof Error ? err.message : String(err)}` },
      502,
      cors,
    );
  }

  // Pass the body through verbatim — HarvestAPI signals a missing profile with
  // a 200 envelope carrying {element: null, error: "..."}, and the client
  // distinguishes those cases itself.
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

/**
 * Similarweb contact enrichment: LinkedIn profile URLs in, emails and phones out.
 *
 * Only `linkedin_url` matching is accepted. Similarweb also matches on name +
 * company, but the bulk response identifies rows ONLY by the contact it found —
 * it comes back reordered and with misses dropped — so a name-matched row could
 * not be joined back to the right person without guessing. A URL round-trips.
 */
async function handleContactsProxy(
  request: Request,
  env: Env,
  user: AuthedUser,
  cors: Record<string, string>,
): Promise<Response> {
  if (!env.SIMILARWEB_API_KEY) {
    return json({ error: 'contact enrichment is not configured on this worker' }, 501, cors);
  }

  let body: { contacts?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: 'invalid JSON body' }, 400, cors);
  }

  const raw = Array.isArray(body.contacts) ? body.contacts : [];
  if (raw.length > MAX_CONTACTS_PER_LOOKUP) {
    return json({ error: `at most ${MAX_CONTACTS_PER_LOOKUP} contacts per request` }, 400, cors);
  }

  const contacts = raw
    .map((entry) => (entry as { linkedin_url?: unknown })?.linkedin_url)
    .filter((url): url is string => typeof url === 'string' && url.length <= MAX_PARAM_LENGTH)
    .map((url) => ({ linkedin_url: url }));

  if (contacts.length === 0) {
    return json({ error: '`contacts` must hold at least one {linkedin_url}' }, 400, cors);
  }

  // Metered on the harvest counter: it is the per-user call ceiling, and this
  // endpoint spends real money the same way the profile lookups do.
  const allowed = await checkAndRecordUsage(env, user.id, 'harvest', {
    limit: intVar(env.DAILY_HARVEST_CALL_LIMIT, 20000),
  });
  if (!allowed) {
    return json({ error: 'daily call limit reached for this token' }, 429, cors);
  }

  let upstream: Response;
  try {
    upstream = await fetch(SIMILARWEB_CONTACTS_URL, {
      method: 'POST',
      headers: {
        'api-key': env.SIMILARWEB_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ contacts, output_fields: SIMILARWEB_OUTPUT_FIELDS }),
    });
  } catch (err) {
    return json(
      { error: `upstream unreachable: ${err instanceof Error ? err.message : String(err)}` },
      502,
      cors,
    );
  }

  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

async function handleScoreProxy(
  request: Request,
  env: Env,
  user: AuthedUser,
  cors: Record<string, string>,
): Promise<Response> {
  let body: { dossier?: unknown; icp?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: 'invalid JSON body' }, 400, cors);
  }

  const dossier = typeof body.dossier === 'string' ? body.dossier : '';
  if (!dossier.trim()) return json({ error: '`dossier` is required' }, 400, cors);
  if (dossier.length > MAX_DOSSIER_CHARS) {
    return json({ error: `dossier too long (${dossier.length} chars)` }, 413, cors);
  }

  const allowed = await checkAndRecordUsage(env, user.id, 'llm', {
    limit: intVar(env.DAILY_LLM_CALL_LIMIT, 5000),
  });
  if (!allowed) {
    return json({ error: 'daily scoring limit reached for this token' }, 429, cors);
  }

  // The ICP may be overridden per run, but the PROMPT and the MODEL are fixed
  // here — that is what stops this endpoint being a general LLM gateway.
  const config = configFor(env);
  const result = await scoreDossier(dossier, {
    apiKey: env.OPENROUTER_API_KEY,
    model: config.model,
    icp: icpText(body.icp) || config.icp,
  });

  return json(result, 200, cors);
}

// ─── Routes ───

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const cors = corsHeaders(env, request);
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (path === '/health') {
      return json({ ok: true }, 200, cors);
    }

    const user = await authenticate(env, request, ctx);
    if (!user) return json({ error: 'unauthorized' }, 401, cors);

    try {
      if (path === '/config' && request.method === 'GET') {
        return json(configFor(env), 200, cors);
      }

      if (path === '/proxy/harvest' && request.method === 'POST') {
        return await handleHarvestProxy(request, env, user, cors);
      }

      if (path === '/proxy/contacts' && request.method === 'POST') {
        return await handleContactsProxy(request, env, user, cors);
      }

      if (path === '/proxy/score' && request.method === 'POST') {
        return await handleScoreProxy(request, env, user, cors);
      }

      if (path === '/runs' && request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as {
          label?: string;
          contact_count?: number;
          icp?: string;
        };
        const runId = crypto.randomUUID();
        await createRun(env, {
          id: runId,
          userId: user.id,
          label: (body.label ?? '').slice(0, 200),
          contactCount: Number(body.contact_count) || 0,
          icp: icpText(body.icp) || configFor(env).icp,
        });
        return json({ run_id: runId }, 201, cors);
      }

      const finishMatch = path.match(/^\/runs\/([A-Za-z0-9-]+)\/finish$/);
      if (finishMatch && request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const updated = await finishRun(env, finishMatch[1], user.id, {
          status: typeof body.status === 'string' ? body.status : 'complete',
          scoredCount: Number(body.scored_count) || 0,
          harvestCalls: Number(body.harvest_calls) || 0,
          llmCalls: Number(body.llm_calls) || 0,
          llmTokensIn: Number(body.llm_tokens_in) || 0,
          llmTokensOut: Number(body.llm_tokens_out) || 0,
          error: typeof body.error === 'string' ? body.error.slice(0, 1000) : null,
        });
        // Same 404 for "no such run" and "someone else's run".
        return updated ? json({ ok: true }, 200, cors) : json({ error: 'run not found' }, 404, cors);
      }

      if (path === '/runs' && request.method === 'GET') {
        return json({ runs: await listRuns(env, user.id) }, 200, cors);
      }

      return json({ error: 'not found' }, 404, cors);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[worker] unhandled error:', message);
      return json({ error: 'internal error', detail: message.slice(0, 300) }, 500, cors);
    }
  },
} satisfies ExportedHandler<Env>;
