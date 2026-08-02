/**
 * ICP scoring via OpenRouter (OpenAI-compatible chat completions).
 *
 * One call per contact. The extension assembles the dossier and POSTs it here;
 * the prompt, the ICP and the model stay server-side, so a leaked bearer token
 * cannot be used to drive an arbitrary LLM request against this key.
 */

import type { Score } from './types';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

// Per-field caps on the dossier. Generous enough to judge fit, small enough
// that 1000 contacts stays affordable.
export interface ScoreUsage {
  calls: number;
  tokensIn: number;
  tokensOut: number;
}

export interface ScoreResult {
  score: Score | null;
  error: string | null;
  usage: ScoreUsage;
}

const SCORE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'fit_score',
    'tier',
    'verdict',
    'seniority',
    'buying_role',
    'rationale',
    'positive_signals',
    'risks',
    'activity_themes',
    'personalized_hook',
    'recommended_channel',
    'confidence',
  ],
  properties: {
    // NO `minimum`/`maximum` here. Anthropic's structured-output validator
    // rejects range keywords on integers outright ("For 'integer' type,
    // properties maximum, minimum are not supported"), which 400s every single
    // scoring call. The 0-100 bound is enforced in normalizeScore instead.
    fit_score: { type: 'integer', description: '0-100' },
    tier: { type: 'string', enum: ['A', 'B', 'C', 'D'] },
    verdict: { type: 'string', enum: ['strong_fit', 'fit', 'weak_fit', 'not_fit'] },
    seniority: { type: 'string' },
    buying_role: {
      type: 'string',
      description: 'economic_buyer | champion | influencer | end_user | gatekeeper | unknown',
    },
    rationale: { type: 'string' },
    positive_signals: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    activity_themes: { type: 'array', items: { type: 'string' } },
    personalized_hook: { type: 'string' },
    recommended_channel: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
} as const;

function systemPrompt(icp: string): string {
  return `You are a B2B sales research analyst. You score one LinkedIn contact at a time against an ideal customer profile and return a single JSON object.

<ideal_customer_profile>
${icp}
</ideal_customer_profile>

Scoring rules:
- fit_score 0-100 against the ICP above. Tier A = 80-100, B = 60-79, C = 40-59, D = 0-39. Keep tier and fit_score consistent.
- verdict: strong_fit (>=80), fit (60-79), weak_fit (40-59), not_fit (<40).
- Judge the PERSON and their COMPANY against the ICP. A senior person at a wrong-fit company is not a fit, and neither is a junior person at a perfect-fit company.
- buying_role: one of economic_buyer, champion, influencer, end_user, gatekeeper, unknown.
- activity_themes: what this person actually posts and comments about, in 2-5 short noun phrases. Empty array if there is no activity.
- personalized_hook: one or two sentences an SDR could open with, grounded in something CONCRETE from this dossier (a specific post, a role change, company news). If nothing concrete exists, return an empty string rather than inventing something.
- risks: reasons this contact may not convert or may be mis-targeted.
- confidence: low when the dossier is sparse or the profile lookup failed.

Never invent facts. Anything not present in the dossier is unknown. Return only the JSON object.`;
}

/**
 * Score one dossier. Never throws — a failure returns `score: null` with the
 * reason, so one bad row cannot abort a 1000-contact run.
 */
export async function scoreDossier(
  dossier: string,
  config: { apiKey: string; model: string; icp: string },
): Promise<ScoreResult> {
  const usage: ScoreUsage = { calls: 0, tokensIn: 0, tokensOut: 0 };

  const messages = [
    { role: 'system', content: systemPrompt(config.icp) },
    { role: 'user', content: `Score this contact.\n\n${dossier}` },
  ];

  // Two attempts. The retry drops `response_format` entirely and asks for raw
  // JSON in the prompt instead, which recovers BOTH failure modes seen in
  // practice: a model that wrapped its answer in prose, and a provider that
  // rejects some corner of the JSON-schema dialect. Schema support varies by
  // provider on OpenRouter, and a schema quirk must degrade rather than fail
  // every contact in the job — parseScore is tolerant enough to carry it.
  let lastError = 'unknown error';

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));

    const structured = attempt === 0;
    const body = {
      model: config.model,
      messages: structured
        ? messages
        : [
            ...messages,
            {
              role: 'system',
              content:
                'Return ONLY the raw JSON object, with exactly these keys: ' +
                `${SCORE_SCHEMA.required.join(', ')}. No prose, no markdown fences.`,
            },
          ],
      temperature: 0.2,
      max_tokens: 1200,
      ...(structured
        ? {
            response_format: {
              type: 'json_schema' as const,
              json_schema: { name: 'icp_score', strict: true, schema: SCORE_SCHEMA },
            },
          }
        : {}),
    };

    usage.calls++;
    let response: Response;
    let text: string;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
          'X-Title': 'SalesNav Enrichment',
        },
        body: JSON.stringify(body),
      });
      // The body read stays INSIDE the try: fetch resolves on headers, so a
      // connection cut mid-stream rejects here, not above. Leaking that
      // rejection would break this function's "never throws" contract and take
      // the whole scoring chunk down with it.
      text = await response.text();
    } catch (err) {
      lastError = `network error: ${err instanceof Error ? err.message : String(err)}`;
      continue;
    }

    if (!response.ok) {
      lastError = `HTTP ${response.status}: ${text.slice(0, 300)}`;
      // A bad model slug or a dead key fails identically on every contact —
      // stop retrying this one and let the caller surface it.
      if (response.status === 401 || response.status === 403 || response.status === 404) break;
      continue;
    }

    let payload: {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      error?: { message?: string };
    };
    try {
      payload = JSON.parse(text);
    } catch {
      lastError = `invalid JSON envelope: ${text.slice(0, 200)}`;
      continue;
    }

    usage.tokensIn += payload.usage?.prompt_tokens ?? 0;
    usage.tokensOut += payload.usage?.completion_tokens ?? 0;

    if (payload.error?.message) {
      lastError = payload.error.message;
      continue;
    }

    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      lastError = 'empty completion';
      continue;
    }

    const score = parseScore(content);
    if (score) return { score, error: null, usage };
    lastError = `unparseable score: ${content.slice(0, 200)}`;
  }

  return { score: null, error: lastError, usage };
}

/** Parse the model's answer, tolerating code fences and surrounding prose. */
export function parseScore(content: string): Score | null {
  const candidates: string[] = [content.trim()];

  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1].trim());

  const firstBrace = content.indexOf('{');
  const lastBrace = content.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(content.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const normalized = normalizeScore(parsed);
    if (normalized) return normalized;
  }
  return null;
}

/** Coerce a parsed object into a Score, filling anything the model omitted. */
function normalizeScore(value: unknown): Score | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.fit_score !== 'number' && typeof raw.fit_score !== 'string') return null;

  const fitScore = clamp(Math.round(Number(raw.fit_score)), 0, 100);
  if (!Number.isFinite(fitScore)) return null;

  const tier = ['A', 'B', 'C', 'D'].includes(String(raw.tier))
    ? (String(raw.tier) as Score['tier'])
    : tierFromScore(fitScore);

  const verdictValues = ['strong_fit', 'fit', 'weak_fit', 'not_fit'];
  const verdict = verdictValues.includes(String(raw.verdict))
    ? (String(raw.verdict) as Score['verdict'])
    : verdictFromScore(fitScore);

  const confidenceValues = ['high', 'medium', 'low'];
  const confidence = confidenceValues.includes(String(raw.confidence))
    ? (String(raw.confidence) as Score['confidence'])
    : 'medium';

  return {
    fit_score: fitScore,
    tier,
    verdict,
    seniority: str(raw.seniority),
    buying_role: str(raw.buying_role) || 'unknown',
    rationale: str(raw.rationale),
    positive_signals: strArray(raw.positive_signals),
    risks: strArray(raw.risks),
    activity_themes: strArray(raw.activity_themes),
    personalized_hook: str(raw.personalized_hook),
    recommended_channel: str(raw.recommended_channel),
    confidence,
  };
}

function tierFromScore(score: number): Score['tier'] {
  if (score >= 80) return 'A';
  if (score >= 60) return 'B';
  if (score >= 40) return 'C';
  return 'D';
}

function verdictFromScore(score: number): Score['verdict'] {
  if (score >= 80) return 'strong_fit';
  if (score >= 60) return 'fit';
  if (score >= 40) return 'weak_fit';
  return 'not_fit';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean);
}
