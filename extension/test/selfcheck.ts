/**
 * Self-check for the enrichment pipeline that now runs in the browser.
 *
 *   npm test
 *
 * No framework on purpose. Every assert guards a failure that is silent in
 * production: a lookup key that returns the wrong person, an activity window
 * that quietly includes the wrong months, a column that mislabels every row.
 */

import * as XLSX from 'xlsx';
import assert from 'node:assert/strict';

import { pool } from '../src/enrichment/harvest';
import {
  toHarvestKey,
  companyKeyOf,
  currentPositions,
  summarizeActivity,
  industryNames,
} from '../src/enrichment/enrich';
import { buildDossier } from '../src/enrichment/dossier';
import { buildWorkbook, workbookFilename } from '../src/enrichment/xlsx';
import { collectScoredContacts, createRunState, runProgress } from '../src/enrichment/runner';
import type {
  EnrichedContact,
  HarvestProfile,
  NormalizedComment,
  NormalizedPost,
  ScoredContact,
} from '../src/enrichment/harvest-types';

let checks = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    checks++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    throw err;
  }
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 1);

function post(daysAgo: number, overrides: Partial<NormalizedPost> = {}): NormalizedPost {
  const ms = NOW - daysAgo * DAY;
  return {
    url: `https://linkedin.com/posts/${daysAgo}`,
    postedAtIso: new Date(ms).toISOString(),
    postedAtMs: ms,
    isRepost: false,
    text: `post from ${daysAgo} days ago`,
    likes: 10,
    comments: 2,
    shares: 1,
    totalEngagement: 13,
    ...overrides,
  };
}

function comment(daysAgo: number): NormalizedComment {
  const ms = NOW - daysAgo * DAY;
  return {
    url: `https://linkedin.com/comment/${daysAgo}`,
    postedAtIso: new Date(ms).toISOString(),
    postedAtMs: ms,
    text: `comment from ${daysAgo} days ago`,
  };
}

const PROFILE: HarvestProfile = {
  id: 'ACwAAAExample',
  publicIdentifier: 'jane-doe',
  linkedinUrl: 'https://www.linkedin.com/in/jane-doe',
  firstName: 'Jane',
  lastName: 'Doe',
  headline: 'VP Finance',
  about: 'Finance leader.',
  location: { linkedinText: 'London, United Kingdom' },
  followerCount: 4200,
  connectionsCount: 500,
  // Live responses omit companyUniversalName entirely — the slug fallback is
  // what actually resolves companies, so the fixture mirrors reality.
  currentPosition: [
    {
      position: 'VP Finance',
      companyName: 'Acme Payments',
      companyLinkedinUrl: 'https://www.linkedin.com/company/acme-payments/',
      startDate: { month: 3, year: 2023 },
    },
  ],
  experience: [],
  education: [],
  skills: [{ name: 'Treasury' }],
};

function enriched(overrides: Partial<EnrichedContact> = {}): EnrichedContact {
  const posts = [post(10), post(40)];
  const comments = [comment(20)];
  return {
    input: {
      linkedin_url: 'https://www.linkedin.com/sales/lead/ACwAAAExample,NAME_SEARCH,abcd',
      name: 'Jane Doe',
      title: 'VP Finance',
      company: 'Acme Payments',
      location: 'London',
    },
    lookupKey: 'profileId:ACwAAAExample',
    profile: PROFILE,
    companyKey: 'acme-payments',
    posts,
    comments,
    activity: summarizeActivity(posts, comments, 3),
    errors: [],
    harvestCalls: 4,
    ...overrides,
  };
}

async function main() {
  console.log('\nsalesnav enrichment (client pipeline) — self-check\n');

  await check('toHarvestKey maps Sales Navigator URLs to profileId', () => {
    assert.deepEqual(
      toHarvestKey('https://www.linkedin.com/sales/lead/ACwAAAExample,NAME_SEARCH,abcd'),
      { type: 'profileId', value: 'ACwAAAExample' },
    );
    assert.deepEqual(
      toHarvestKey('https://www.linkedin.com/sales/people/ACoAAAOther,NAME_SEARCH,x'),
      { type: 'profileId', value: 'ACoAAAOther' },
    );
    assert.deepEqual(toHarvestKey('https://www.linkedin.com/in/jane-doe'), {
      type: 'url',
      value: 'https://www.linkedin.com/in/jane-doe',
    });
  });

  await check('companyKeyOf falls back to the URL slug, which live data always needs', () => {
    assert.equal(companyKeyOf(PROFILE), 'acme-payments');
    assert.equal(
      companyKeyOf({ currentPosition: { companyUniversalName: 'beta-corp' } }),
      'beta-corp',
    );
    assert.equal(
      companyKeyOf({
        experience: [
          { companyUniversalName: 'old-co', endDate: { year: 2020 } },
          { companyUniversalName: 'current-co' },
        ],
      }),
      'current-co',
    );
    assert.equal(companyKeyOf(null), null);
  });

  await check('currentPositions normalizes object, array and missing shapes', () => {
    assert.equal(currentPositions(PROFILE).length, 1);
    assert.equal(currentPositions({ currentPosition: { position: 'CEO' } }).length, 1);
    assert.equal(currentPositions({}).length, 0);
    assert.equal(currentPositions(null).length, 0);
  });

  // HarvestAPI returns industries as OBJECTS despite the docs promising
  // strings. Joining them raw writes "[object Object]" into every row.
  await check('industryNames flattens both the documented and the live shape', () => {
    assert.deepEqual(
      industryNames({ industries: [{ id: '43', name: 'Financial Services' } as any] }),
      ['Financial Services'],
    );
    assert.deepEqual(industryNames({ industries: ['Software'] }), ['Software']);
    assert.deepEqual(industryNames({ industries: [{ title: 'Logistics' } as any] }), ['Logistics']);
    assert.deepEqual(industryNames({ industries: [{} as any, ''] }), []);
    assert.deepEqual(industryNames(null), []);
  });

  await check('summarizeActivity counts reposts, engagement and last activity', () => {
    const posts = [post(5), post(30, { isRepost: true, totalEngagement: 7 }), post(100)];
    const comments = [comment(2), comment(60)];
    const stats = summarizeActivity(posts, comments, 9);

    assert.equal(stats.postCount, 3);
    assert.equal(stats.originalPostCount, 2);
    assert.equal(stats.repostCount, 1);
    assert.equal(stats.commentCount, 2);
    assert.equal(stats.reactionCount, 9);
    assert.equal(stats.totalEngagement, 13 + 7 + 13);
    assert.equal(stats.isActive, true);
    assert.equal(stats.lastActivityIso, new Date(NOW - 2 * DAY).toISOString());
    assert.equal(stats.windowMonths, 6);
  });

  await check('summarizeActivity reports silence as inactive, not zero engagement', () => {
    const stats = summarizeActivity([], [], 0);
    assert.equal(stats.isActive, false);
    assert.equal(stats.lastActivityIso, null);
    assert.equal(stats.avgEngagementPerPost, 0);
  });

  await check('pool preserves order and never exceeds the limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const tasks = Array.from({ length: 20 }, (_, index) => async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, (index % 4) * 5));
      inFlight--;
      return index;
    });
    const results = await pool(tasks, 5);
    assert.deepEqual(results, Array.from({ length: 20 }, (_, i) => i));
    assert.ok(peak <= 5, `peak concurrency ${peak} exceeded limit 5`);
    assert.ok(peak > 1, 'pool did not run anything concurrently');
  });

  await check('pool handles an empty list and a limit above the task count', async () => {
    assert.deepEqual(await pool([], 5), []);
    assert.deepEqual(await pool([async () => 'a'], 10), ['a']);
  });

  await check('dossier carries profile, company and activity through to the model', () => {
    const dossier = buildDossier(enriched(), {
      name: 'Acme Payments',
      industries: [{ name: 'Financial Services' } as any],
      employeeCount: 900,
    });
    assert.match(dossier, /Jane Doe/);
    assert.match(dossier, /VP Finance/);
    assert.match(dossier, /Industries: Financial Services/);
    assert.match(dossier, /LINKEDIN ACTIVITY \(last 6 months\)/);
    assert.match(dossier, /Posts: 2/);
    assert.ok(!dossier.includes('[object Object]'), 'dossier leaked an unrendered object');

    const broken = buildDossier(enriched({ profile: null, errors: ['profile: HTTP 404'] }), null);
    assert.match(broken, /profile lookup failed/);
    assert.match(broken, /company lookup failed/);
    assert.match(broken, /DATA GAPS/);
  });

  // The run is persisted at every chunk boundary and resumed from the cursor —
  // if the cursor and the collected rows disagree, work is lost or re-billed.
  await check('a partially-scored run still exports every enriched row', () => {
    const state = createRunState(
      [
        { linkedin_url: 'https://www.linkedin.com/sales/lead/A,N,x' },
        { linkedin_url: 'https://www.linkedin.com/sales/lead/B,N,x' },
      ],
      { label: 'partial', icp: '', now: NOW },
    );
    state.enriched = [enriched(), enriched()];
    state.scores = [{ score: null, scoreError: null }];
    state.scoreCursor = 1;
    state.phase = 'stopped';

    const rows = collectScoredContacts(state);
    assert.equal(rows.length, 2, 'an enriched but unscored contact was dropped');
    assert.equal(rows[1].scoreError, 'not scored — run ended early');
    assert.equal(runProgress(state).total, 2);
  });

  await check('workbook header and data rows stay aligned on every sheet', async () => {
    const items: ScoredContact[] = [
      {
        enriched: enriched(),
        company: {
          name: 'Acme Payments',
          industries: [{ name: 'Financial Services' } as any],
          employeeCount: 900,
          website: 'https://acme.example',
        },
        score: {
          fit_score: 91,
          tier: 'A',
          verdict: 'strong_fit',
          seniority: 'VP',
          buying_role: 'economic_buyer',
          rationale: 'Motion A — real cross-border volume.',
          positive_signals: ['posts about FX'],
          risks: [],
          activity_themes: ['treasury'],
          personalized_hook: 'Saw your post.',
          recommended_channel: 'LinkedIn',
          confidence: 'high',
        },
        scoreError: null,
      },
      {
        enriched: enriched({
          profile: null,
          companyKey: null,
          posts: [],
          comments: [],
          activity: summarizeActivity([], [], 0),
          errors: ['profile: HTTP 404'],
        }),
        company: null,
        score: null,
        scoreError: 'HTTP 402: out of credits',
      },
    ];

    const buffer = await buildWorkbook(
      items,
      {
        jobId: 'run-1234',
        label: 'fintech-cfos',
        userId: 'amrit',
        icp: 'Finance leaders at payment companies.',
        model: 'anthropic/claude-sonnet-5',
        createdAt: new Date(NOW).toISOString(),
        finishedAt: new Date(NOW + 3600_000).toISOString(),
      },
      NOW,
    );

    // Read back with a real parser: the writer is hand-rolled OOXML, so
    // "a spreadsheet app can open this" is the assertion that matters.
    const book = XLSX.read(buffer, { type: 'array' });
    assert.deepEqual(book.SheetNames, ['Scored Contacts', 'Activity', 'Run Info']);

    for (const sheetName of ['Scored Contacts', 'Activity']) {
      const rows = XLSX.utils.sheet_to_json<string[]>(book.Sheets[sheetName], {
        header: 1,
        blankrows: false,
        defval: '',
      });
      const [header, ...body] = rows;
      assert.ok(body.length > 0, `${sheetName} has no data rows`);
      for (const [index, row] of body.entries()) {
        assert.equal(
          row.length,
          header.length,
          `${sheetName} row ${index} has ${row.length} cells, header has ${header.length}`,
        );
      }
    }

    const contactRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(
      book.Sheets['Scored Contacts'],
      { defval: '' },
    );
    assert.equal(contactRows.length, 2);
    assert.equal(contactRows[0]['Fit Score'], 91);
    assert.equal(contactRows[0]['Name'], 'Jane Doe');
    assert.equal(contactRows[0]['Company Industry'], 'Financial Services');
    assert.equal(contactRows[0]['Posts (6mo)'], 2);
    assert.equal(contactRows[1]['Fit Score'], '');
    assert.equal(contactRows[1]['Verdict'], 'scoring_failed');
    assert.match(String(contactRows[1]['Data Gaps']), /HTTP 404/);
    assert.ok(!JSON.stringify(contactRows).includes('[object Object]'));

    const activityRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(book.Sheets['Activity'], {
      defval: '',
    });
    assert.equal(activityRows.length, 3);
    assert.ok(activityRows.every((row) => row['Name'] === 'Jane Doe'));
  });

  await check('workbook stays correct at a full 1000-contact run', async () => {
    const N = 1000;
    const items: ScoredContact[] = Array.from({ length: N }, (_, i) => ({
      enriched: enriched({
        input: {
          linkedin_url: `https://www.linkedin.com/sales/lead/ACwAAA${i},NAME,x`,
          name: `Person ${i}`,
          company: `Company ${i}`,
        },
      }),
      company: { name: `Company ${i}` },
      score: {
        fit_score: i % 101,
        tier: 'B',
        verdict: 'fit',
        seniority: '',
        buying_role: '',
        rationale: '',
        positive_signals: [],
        risks: [],
        activity_themes: [],
        personalized_hook: '',
        recommended_channel: '',
        confidence: 'medium',
      },
      scoreError: null,
    }));

    const buffer = await buildWorkbook(
      items,
      {
        jobId: 'big',
        label: 'big-run',
        userId: 'amrit',
        icp: 'x',
        model: 'm',
        createdAt: new Date(NOW).toISOString(),
        finishedAt: new Date(NOW).toISOString(),
      },
      NOW,
    );

    const book = XLSX.read(buffer, { type: 'array' });
    const contacts = XLSX.utils.sheet_to_json<Record<string, unknown>>(
      book.Sheets['Scored Contacts'],
      { defval: '' },
    );
    assert.equal(contacts.length, N);
    assert.equal(contacts[0]['Fit Score'], 100, 'rows are not sorted best-fit first');
    assert.equal(
      XLSX.utils.sheet_to_json(book.Sheets['Activity'], { defval: '' }).length,
      N * 3,
    );
    assert.ok(buffer.byteLength < 12 * 1024 * 1024, `workbook is ${buffer.byteLength} bytes`);
  });

  await check('workbookFilename is filesystem safe and carries the label', () => {
    const name = workbookFilename('Fintech / CFOs — UK!', 'abcdef12-3456', '2026-08-01T10:20:30.000Z');
    assert.match(name, /\.xlsx$/);
    assert.ok(!/[/\\:*?"<>|]/.test(name), `unsafe characters in ${name}`);
    assert.match(name, /Fintech_CFOs_UK/);
    assert.match(workbookFilename('', 'abcdef12', '2026-08-01T10:20:30.000Z'), /^salesnav__/);
  });

  console.log(`\n${checks} checks passed\n`);
}

main().catch((err) => {
  console.error('\n', err);
  process.exit(1);
});
