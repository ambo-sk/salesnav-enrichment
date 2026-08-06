/**
 * Score a run again outside the browser, straight to a workbook.
 *
 *   npm run rescore -- <enrichmentRun.json> [--out dir] [--token snv_...]
 *
 * The escape hatch for when the extension will not drive the run itself: a
 * service worker that dies silently, a settings page that lost its token, a
 * popup button that no-ops. Everything this needs is already inside the
 * exported state — `enriched` and `companies` hold the HarvestAPI half, which
 * is the half that costs money. Only the LLM calls are spent again.
 *
 * Export the state from the extension's Options page console:
 *
 *   const { enrichmentRun } = await chrome.storage.local.get('enrichmentRun');
 *   const a = document.createElement('a');
 *   a.href = URL.createObjectURL(new Blob([JSON.stringify(enrichmentRun)]));
 *   a.download = 'enrichmentRun.json';
 *   a.click();
 *
 * Deliberately reuses the extension's own dossier builder, scoring client and
 * workbook writer — a second implementation would drift from what the popup
 * produces, and the point of this script is a workbook you can trust.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import { pool } from '../src/enrichment/harvest';
import { buildDossier } from '../src/enrichment/dossier';
import { scoreDossier } from '../src/enrichment/score';
import { buildWorkbook, workbookFilename } from '../src/enrichment/xlsx';
import { collectScoredContacts, companyFor, type RunState } from '../src/enrichment/runner';

const WORKER_URL = process.env.WORKER_URL ?? 'https://salesnav-enrichment.gtm-ai.workers.dev';
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 5);

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const input = process.argv[2];
  if (!input || input.startsWith('--')) {
    console.error('usage: npm run rescore -- <enrichmentRun.json> [--out dir] [--token snv_...]');
    process.exit(1);
  }

  const token = arg('token') ?? process.env.API_TOKEN;
  if (!token) {
    console.error('No token. Pass --token snv_... or set API_TOKEN.');
    process.exit(1);
  }

  const outDir = arg('out') ?? '.';
  const state = JSON.parse(readFileSync(input, 'utf8')) as RunState;

  if (!Array.isArray(state.enriched) || state.enriched.length === 0) {
    console.error(`${basename(input)} holds no enriched contacts — nothing to score.`);
    process.exit(1);
  }

  const total = state.enriched.length;
  const before = (state.scores ?? []).filter((s) => s?.score).length;
  console.log(`\n${total} enriched contacts, ${before} currently scored. Re-scoring all of them.`);
  console.log(`worker: ${WORKER_URL}  concurrency: ${CONCURRENCY}\n`);

  let done = 0;
  const results = await pool(
    state.enriched.map((contact) => async () => {
      const dossier = buildDossier(contact, companyFor(state, contact));
      const result = await scoreDossier(dossier, {
        workerUrl: WORKER_URL,
        apiToken: token,
        icp: state.icp || undefined,
      });
      done++;
      const who = contact.input.name || contact.input.linkedin_url;
      console.log(
        result.score
          ? `  ${done}/${total}  ${result.score.fit_score} ${result.score.tier}  ${who}`
          : `  ${done}/${total}  FAILED  ${who} — ${result.error}`,
      );
      return result;
    }),
    CONCURRENCY,
  );

  // pool preserves order, so scores stay index-aligned with `enriched` — which
  // is the invariant collectScoredContacts zips the workbook rows on.
  state.scores = results.map((r) => ({ score: r.score, scoreError: r.error }));
  state.totals.llmCalls += results.reduce((sum, r) => sum + r.usage.calls, 0);
  state.totals.llmTokensIn += results.reduce((sum, r) => sum + r.usage.tokensIn, 0);
  state.totals.llmTokensOut += results.reduce((sum, r) => sum + r.usage.tokensOut, 0);
  state.scoreCursor = total;
  state.phase = 'complete';
  state.finishedAt = new Date().toISOString();
  state.error = null;

  const scored = results.filter((r) => r.score).length;
  const items = collectScoredContacts(state);
  const buffer = await buildWorkbook(
    items,
    {
      jobId: state.localId,
      label: state.label,
      userId: new URL(WORKER_URL).hostname,
      icp: state.icp || "(worker default — see the worker's src/icp.ts)",
      model: 'worker-configured',
      createdAt: state.startedAt,
      finishedAt: state.finishedAt,
    },
    state.now,
  );

  mkdirSync(outDir, { recursive: true });
  const xlsxPath = join(outDir, workbookFilename(state.label, state.localId, state.startedAt));
  const statePath = join(outDir, `${basename(input, '.json')}.scored.json`);
  writeFileSync(xlsxPath, Buffer.from(buffer as unknown as ArrayBuffer));
  writeFileSync(statePath, JSON.stringify(state));

  const failed = results.filter((r) => !r.score);
  console.log(`\nscored ${scored}/${total} (was ${before})`);
  if (failed.length) {
    const reasons = new Map<string, number>();
    for (const f of failed) {
      const key = (f.error ?? 'unknown').slice(0, 80);
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
    }
    console.log('failures:');
    for (const [reason, count] of reasons) console.log(`  ${count}x  ${reason}`);
  }
  console.log(`tokens: ${state.totals.llmTokensIn} in / ${state.totals.llmTokensOut} out`);
  console.log(`\nworkbook: ${xlsxPath}`);
  console.log(`state:    ${statePath}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
