/**
 * D1 access: token auth, per-user daily quotas, run history.
 *
 * Tokens are stored as SHA-256 hex digests. Nothing in this database can be
 * replayed as a credential, and lookups stay a single indexed primary-key hit.
 */

import type { AuthedUser, Env, RunRow } from './types';

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Resolve a bearer token to its user, or null.
 * `last_used_at` is refreshed opportunistically — a failure there must never
 * block a request, so it is fire-and-forget via the caller's waitUntil.
 */
export async function authenticate(
  env: Env,
  request: Request,
  ctx?: ExecutionContext,
): Promise<AuthedUser | null> {
  const header = request.headers.get('Authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  const token = match[1].trim();
  if (!token) return null;

  const hash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT u.id AS id, u.name AS name
       FROM tokens t
       JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ?1 AND t.active = 1 AND u.active = 1`,
  )
    .bind(hash)
    .first<{ id: string; name: string }>();

  if (!row) return null;

  const touch = env.DB.prepare(`UPDATE tokens SET last_used_at = datetime('now') WHERE token_hash = ?1`)
    .bind(hash)
    .run();
  if (ctx) ctx.waitUntil(touch.catch(() => undefined));
  else await touch.catch(() => undefined);

  return { id: row.id, name: row.name };
}

// ─── Daily quota ───

/**
 * Count one proxied call against the user's daily allowance and report whether
 * it may proceed.
 *
 * This is the only thing standing between a leaked bearer token and the API
 * balance: the keys live here, so anyone holding a token can spend real money
 * through the proxy. The counter is a single UPSERT per call (~4,300 writes for
 * a 1000-contact run, against D1's 100k/day free ceiling).
 *
 * Fails OPEN on a database error. A D1 blip must not halt a paid-for run
 * mid-flight; the ceiling is a cost guard rail, not a security boundary — that
 * job belongs to the token check.
 */
export async function checkAndRecordUsage(
  env: Env,
  userId: string,
  kind: 'harvest' | 'llm',
  opts: { limit: number },
): Promise<boolean> {
  const column = kind === 'harvest' ? 'harvest_calls' : 'llm_calls';
  try {
    const row = await env.DB.prepare(
      `INSERT INTO daily_usage (user_id, day, ${column})
       VALUES (?1, date('now'), 1)
       ON CONFLICT(user_id, day) DO UPDATE SET ${column} = ${column} + 1
       RETURNING ${column} AS used`,
    )
      .bind(userId)
      .first<{ used: number }>();

    return (row?.used ?? 0) <= opts.limit;
  } catch (err) {
    console.error('[db] usage check failed, allowing request:', err);
    return true;
  }
}

// ─── Runs ───

export async function createRun(
  env: Env,
  run: { id: string; userId: string; label: string; contactCount: number; icp: string },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO runs (id, user_id, label, status, contact_count, icp)
     VALUES (?1, ?2, ?3, 'running', ?4, ?5)`,
  )
    .bind(run.id, run.userId, run.label, run.contactCount, run.icp)
    .run();
}

/** Returns false when the run does not exist or belongs to another user. */
export async function finishRun(
  env: Env,
  runId: string,
  userId: string,
  totals: {
    status: string;
    scoredCount: number;
    harvestCalls: number;
    llmCalls: number;
    llmTokensIn: number;
    llmTokensOut: number;
    error: string | null;
  },
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE runs
        SET status = ?1, scored_count = ?2, harvest_calls = ?3, llm_calls = ?4,
            llm_tokens_in = ?5, llm_tokens_out = ?6, error = ?7,
            finished_at = datetime('now')
      WHERE id = ?8 AND user_id = ?9`,
  )
    .bind(
      totals.status,
      totals.scoredCount,
      totals.harvestCalls,
      totals.llmCalls,
      totals.llmTokensIn,
      totals.llmTokensOut,
      totals.error,
      runId,
      userId,
    )
    .run();

  return (result.meta?.changes ?? 0) > 0;
}

export async function listRuns(env: Env, userId: string, limit = 50): Promise<RunRow[]> {
  const result = await env.DB.prepare(
    `SELECT id, user_id, label, status, contact_count, scored_count, harvest_calls,
            llm_calls, llm_tokens_in, llm_tokens_out, error, created_at, finished_at
       FROM runs WHERE user_id = ?1 ORDER BY created_at DESC LIMIT ?2`,
  )
    .bind(userId, limit)
    .all<RunRow>();
  return result.results ?? [];
}
