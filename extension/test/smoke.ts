/**
 * Live end-to-end smoke test against the DEPLOYED worker.
 *
 * Costs real HarvestAPI credits and OpenRouter tokens, so it is not part of
 * `npm test`.
 *
 *   WORKER_URL=https://... API_TOKEN=snv_... npm run smoke -- <linkedin-url> [...]
 *
 * Drives the same runner the background service worker uses, so it exercises
 * the whole path: proxy auth, the Harvest proxy, the company dedup, the
 * dossier, the scoring proxy, the run state machine and the workbook.
 */

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { fetchConfig } from '../src/utils/worker-api';
import {
  advanceRun,
  collectScoredContacts,
  createRunState,
  runProgress,
  type RunState,
} from '../src/enrichment/runner';
import { buildWorkbook } from '../src/enrichment/xlsx';

const WORKER_URL = (process.env.WORKER_URL ?? '').replace(/\/+$/, '');
const API_TOKEN = process.env.API_TOKEN ?? '';

if (!WORKER_URL || !API_TOKEN) {
  console.error('set WORKER_URL and API_TOKEN');
  process.exit(1);
}

const urls = process.argv.slice(2);
if (urls.length === 0) {
  console.error('usage: npm run smoke -- <linkedin-url> [...]');
  process.exit(1);
}

async function main() {
  const config = await fetchConfig({ workerUrl: WORKER_URL, apiToken: API_TOKEN });
  console.log(`\nworker config: model ${config.model}, concurrency ${config.harvestConcurrency}`);
  console.log(`ICP: ${config.icp.split('\n')[0]} (${config.icp.length} chars)\n`);

  const state: RunState = createRunState(
    urls.map((url) => ({ linkedin_url: url })),
    { label: 'smoke', icp: '', now: Date.now() },
  );

  // Exactly what the background does, including the persistence callback —
  // here it just snapshots so we can prove the cursor advances monotonically.
  const cursors: string[] = [];
  let more = true;
  while (more) {
    more = await advanceRun(state, {
      workerUrl: WORKER_URL,
      apiToken: API_TOKEN,
      config,
      save: async (next) => {
        const progress = runProgress(next);
        const line = `${next.phase} ${progress.done}/${progress.total}`;
        if (cursors[cursors.length - 1] !== line) {
          cursors.push(line);
          console.log(`  ${line}`);
        }
      },
      shouldStop: async () => false,
    });
  }

  console.log(`\nphase: ${state.phase}${state.error ? ` (${state.error})` : ''}`);
  console.log(
    `harvest calls: ${state.totals.harvestCalls} | scoring calls: ${state.totals.llmCalls} | ` +
      `tokens ${state.totals.llmTokensIn} in / ${state.totals.llmTokensOut} out`,
  );

  const items = collectScoredContacts(state);
  for (const item of items) {
    const name =
      [item.enriched.profile?.firstName, item.enriched.profile?.lastName].filter(Boolean).join(' ') ||
      item.enriched.input.linkedin_url;
    console.log(`\n${'─'.repeat(70)}\n${name}`);
    console.log(`  company : ${item.enriched.companyKey ?? '(none)'} -> ${item.company?.name ?? '(unresolved)'}`);
    if (item.enriched.errors.length) console.log(`  gaps    : ${item.enriched.errors.join(' | ')}`);
    if (!item.score) {
      console.log(`  SCORING FAILED: ${item.scoreError}`);
      continue;
    }
    console.log(
      `  fit     : ${item.score.fit_score} (tier ${item.score.tier}, ${item.score.verdict}, ` +
        `${item.score.confidence} confidence, ${item.score.buying_role})`,
    );
    console.log(`  why     : ${item.score.rationale.slice(0, 200)}`);
    console.log(`  hook    : ${item.score.personalized_hook.slice(0, 200) || '(none)'}`);
  }

  const buffer = await buildWorkbook(
    items,
    {
      jobId: state.localId,
      label: state.label,
      userId: 'smoke',
      icp: config.icp,
      model: config.model,
      createdAt: state.startedAt,
      finishedAt: state.finishedAt ?? new Date().toISOString(),
    },
    state.now,
  );

  const out = '/tmp/salesnav-smoke.xlsx';
  writeFileSync(out, buffer);
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`workbook: ${out} (${buffer.byteLength} bytes)`);

  assert.equal(state.phase, 'complete', `run ended as ${state.phase}: ${state.error}`);
  assert.equal(items.filter((i) => i.score).length, urls.length, 'not every contact was scored');
  console.log(`scored ${items.length}/${urls.length}\n`);
}

main().catch((err) => {
  console.error('\n', err);
  process.exit(1);
});
