/**
 * Self-check for the enrichment pipeline that now runs in the browser.
 *
 *   npm test
 *
 * No framework on purpose. Every assert guards a failure that is silent in
 * production: a lookup key that returns the wrong person, a tenure computed off
 * the wrong date, a column that mislabels every row.
 */

import * as XLSX from 'xlsx';
import assert from 'node:assert/strict';

import { pool } from '../src/enrichment/harvest';
import {
  toHarvestKey,
  companyKeyOf,
  currentPositions,
  industryNames,
} from '../src/enrichment/enrich';
import { buildDossier } from '../src/enrichment/dossier';
import { contactKey, indexContacts } from '../src/enrichment/contacts';
import {
  buildWorkbook,
  workbookFilename,
  buildCompanyWorkbook,
  companyWorkbookFilename,
} from '../src/enrichment/xlsx';
import {
  collectScoredContacts,
  createRunState,
  resetScoring,
  runProgress,
} from '../src/enrichment/runner';
import type {
  EnrichedContact,
  HarvestProfile,
  ScoredContact,
} from '../src/enrichment/harvest-types';

/**
 * The .xlsx is a hand-rolled zip, and SheetJS reads a malformed one happily —
 * Excel does not, it "repairs" it. So assert the end-of-central-directory record
 * itself: the directory must start where it says and end exactly at the EOCD.
 */
function assertValidZip(buffer: Uint8Array): void {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert.notEqual(eocd, -1, 'no end-of-central-directory record');
  assert.equal(eocd, buffer.length - 22, 'trailing bytes after the EOCD');

  const entries = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralStart = view.getUint32(eocd + 16, true);
  assert.equal(
    centralStart + centralSize,
    eocd,
    'central directory size/offset do not land on the EOCD — Excel will repair this file',
  );
  assert.equal(view.getUint32(centralStart, true), 0x02014b50, 'central directory magic');
  assert.equal(view.getUint32(0, true), 0x04034b50, 'first local file header magic');
  assert.ok(entries > 0, 'archive declares no entries');
}

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

const NOW = Date.UTC(2026, 7, 1);

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

  await check('dossier carries profile and company through to the model, with no activity', () => {
    const dossier = buildDossier(enriched(), {
      name: 'Acme Payments',
      industries: [{ name: 'Financial Services' } as any],
      employeeCount: 900,
    });
    assert.match(dossier, /Jane Doe/);
    assert.match(dossier, /VP Finance/);
    assert.match(dossier, /Industries: Financial Services/);
    // The scorer must never be handed activity it can then "personalize" on.
    assert.ok(!/ACTIVITY|Recent posts|Recent comments/.test(dossier), 'dossier still carries activity');
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

  await check('a re-score rewinds phase C without touching the paid enrichment', () => {
    const state = createRunState(
      [
        { linkedin_url: 'https://www.linkedin.com/sales/lead/A,N,x' },
        { linkedin_url: 'https://www.linkedin.com/sales/lead/B,N,x' },
      ],
      { label: 'rescore', icp: '', now: NOW },
    );
    state.enriched = [enriched(), enriched()];
    state.companies = { 'slug:acme': { name: 'Acme' } as any };
    state.scores = [
      { score: null, scoreError: 'unparseable score' },
      { score: null, scoreError: 'unparseable score' },
    ];
    state.scoreCursor = 2;
    state.phase = 'complete';
    state.finishedAt = new Date(NOW).toISOString();
    state.error = 'boom';
    state.totals.harvestCalls = 124;

    resetScoring(state, NOW);

    assert.equal(state.phase, 'scoring');
    assert.equal(state.scoreCursor, 0);
    // Stale scores MUST be dropped, not appended to — phase C pushes, so a
    // leftover array would double up and misalign every row against `enriched`.
    assert.equal(state.scores.length, 0);
    assert.equal(state.error, null);
    assert.equal(state.finishedAt, null);
    // The expensive half survives: no profile, post or company is re-fetched.
    assert.equal(state.enriched.length, 2);
    assert.equal(Object.keys(state.companies).length, 1);
    assert.equal(state.totals.harvestCalls, 124);
  });

  // Similarweb's bulk endpoint returns rows REORDERED and drops the misses:
  // three URLs in, two rows out, in a different order (observed live). Zipping
  // the response against the request by index would attach the wrong person's
  // email and phone number to a row — the one failure here nothing downstream
  // could ever detect.
  await check('contact rows are joined by URL, never by response order', () => {
    const payload = {
      data: [
        {
          linked_in_url: 'https://www.linkedin.com/in/bravo',
          emails: ['b@example.com'],
          direct_phones: ['+1 555 0002'],
          mobile_phones: [],
          accuracy_score: 90,
          direct_phone_do_not_call: null,
          mobile_phone_do_not_call: null,
        },
        {
          linked_in_url: 'https://www.linkedin.com/in/alpha',
          emails: ['a@example.com'],
          direct_phones: [],
          mobile_phones: ['+1 555 0001'],
          accuracy_score: 93,
          direct_phone_do_not_call: false,
          mobile_phone_do_not_call: false,
        },
      ],
    };

    const found = indexContacts(payload);
    const requested = [
      'linkedin.com/in/alpha',
      'https://uk.linkedin.com/in/BRAVO/',
      'https://www.linkedin.com/in/charlie?trk=x',
    ];
    const joined = requested.map((url) => found.get(contactKey(url)) ?? null);

    assert.equal(joined[0]?.emails[0], 'a@example.com', 'response order was trusted over the URL');
    // Case, locale subdomain and trailing slash all vary between what we send
    // and what comes back; all three must still land on the same row.
    assert.equal(joined[1]?.emails[0], 'b@example.com');
    assert.equal(joined[2], null, 'a dropped miss was filled with another contact');
    assert.equal(joined[1]?.mobilePhones.length, 0);
  });

  await check('workbook header and data rows stay aligned on every sheet', async () => {
    const items: ScoredContact[] = [
      {
        enriched: enriched(),
        company: {
          name: 'Acme Payments',
          linkedinUrl: 'https://www.linkedin.com/company/acme-payments',
          companyType: 'Privately Held',
          industries: [{ name: 'Financial Services' } as any],
          employeeCount: 900,
          website: 'https://acme.example',
          locations: [
            { city: 'London', country: 'GB', headquarter: true },
            { city: 'Lisbon', country: 'PT' },
          ],
        },
        score: {
          fit_score: 91,
          tier: 'A',
          verdict: 'strong_fit',
          seniority: 'VP',
          buying_role: 'economic_buyer',
          rationale: 'Motion A — real cross-border volume.',
          positive_signals: ['owns treasury'],
          risks: [],
          personalized_hook: 'Three years running treasury at Acme.',
          recommended_channel: 'LinkedIn',
          confidence: 'high',
        },
        scoreError: null,
        contact: {
          emails: ['jane.doe@acme.example'],
          directPhones: ['+44 20 7946 0000'],
          mobilePhones: ['+44 7700 900000'],
          accuracyScore: 93,
          directPhoneDoNotCall: false,
          mobilePhoneDoNotCall: true,
        },
      },
      {
        enriched: enriched({
          profile: null,
          companyKey: null,
          errors: ['profile: HTTP 404'],
        }),
        company: null,
        score: null,
        scoreError: 'HTTP 402: out of credits',
        contact: null,
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
    assert.deepEqual(book.SheetNames, ['Scored Contacts', 'Run Info']);

    const rows = XLSX.utils.sheet_to_json<string[]>(book.Sheets['Scored Contacts'], {
      header: 1,
      blankrows: false,
      defval: '',
    });
    const [header, ...body] = rows;
    assert.deepEqual(header, [
      'Personal Linkedin URL',
      'First Name',
      'Last Name',
      'Job Title',
      'Company Name',
      'Website',
      'Company Type',
      'Company HQ',
      'Company offices',
      'Company Linkedin URL',
      'Email',
      'Direct Phone',
      'Mobile Phone',
      'Contact Accuracy',
      'Personalized Hook',
      'Top Skills',
      'Tenure (months)',
      'Rationale',
      'Current Experiences',
    ]);
    assert.ok(body.length > 0, 'Scored Contacts has no data rows');
    for (const [index, row] of body.entries()) {
      assert.equal(
        row.length,
        header.length,
        `Scored Contacts row ${index} has ${row.length} cells, header has ${header.length}`,
      );
    }

    const contactRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(
      book.Sheets['Scored Contacts'],
      { defval: '' },
    );
    assert.equal(contactRows.length, 2);
    assert.equal(contactRows[0]['First Name'], 'Jane');
    assert.equal(contactRows[0]['Last Name'], 'Doe');
    assert.equal(contactRows[0]['Job Title'], 'VP Finance');
    assert.equal(contactRows[0]['Personal Linkedin URL'], 'https://www.linkedin.com/in/jane-doe');
    assert.equal(contactRows[0]['Company HQ'], 'London, GB');
    assert.equal(contactRows[0]['Company offices'], 'London, GB | Lisbon, PT');
    assert.equal(contactRows[0]['Top Skills'], 'Treasury');
    // March 2023 -> August 2026 is 41 months.
    assert.equal(contactRows[0]['Tenure (months)'], 41);
    assert.equal(contactRows[0]['Current Experiences'], 'Acme Payments — VP Finance (2023)');
    assert.equal(contactRows[0]['Rationale'], 'Motion A — real cross-border volume.');
    assert.equal(contactRows[0]['Email'], 'jane.doe@acme.example');
    assert.equal(contactRows[0]['Direct Phone'], '+44 20 7946 0000');
    // A do-not-call number must never export as a bare, dialable-looking cell.
    assert.equal(contactRows[0]['Mobile Phone'], '+44 7700 900000 (DNC)');
    assert.equal(contactRows[0]['Contact Accuracy'], 93);
    assert.equal(contactRows[1]['Email'], '');
    // The profile failed here: the row still carries the scraped name and URL.
    assert.equal(contactRows[1]['First Name'], 'Jane');
    assert.equal(contactRows[1]['Personalized Hook'], '');
    assert.match(String(contactRows[1]['Personal Linkedin URL']), /sales\/lead/);
    assert.ok(!JSON.stringify(contactRows).includes('[object Object]'));
    assertValidZip(buffer);
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
        personalized_hook: '',
        recommended_channel: '',
        confidence: 'medium',
      },
      scoreError: null,
      contact: null,
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
    // Fit score is no longer a column, so best-fit-first is asserted through
    // the row it belongs to: contact 100 scores 100 and must lead.
    assert.equal(contacts[0]['Company Name'], 'Company 100', 'rows are not sorted best-fit first');
    assert.ok(buffer.byteLength < 12 * 1024 * 1024, `workbook is ${buffer.byteLength} bytes`);
  });

  await check('company workbook opens, keeps its columns, and stays formula-inert', async () => {
    const buffer = await buildCompanyWorkbook(
      [
        {
          name: '=HYPERLINK("http://evil.example")',
          industry: 'Financial Services',
          employees: '51-200',
          location: 'London, England',
          about: 'Cross-border payments.',
          companyUrl: 'https://www.linkedin.com/sales/company/12345',
          scrapedAt: new Date(NOW).toISOString(),
        },
        {
          name: 'Acme Payments',
          industry: '',
          employees: '10K+',
          location: '',
          about: '',
          companyUrl: 'https://www.linkedin.com/sales/company/67890',
          scrapedAt: new Date(NOW).toISOString(),
        },
      ],
      NOW,
    );

    const book = XLSX.read(buffer, { type: 'array' });
    assert.deepEqual(book.SheetNames, ['Companies']);
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(book.Sheets['Companies'], {
      defval: '',
    });
    assert.equal(rows.length, 2);
    // Inline strings, never formulas: the scraped name survives verbatim as text.
    assert.equal(rows[0]['Company Name'], '=HYPERLINK("http://evil.example")');
    assert.equal(rows[0]['Employees'], '51-200');
    assert.equal(rows[1]['Company Name'], 'Acme Payments');
    assert.match(String(rows[1]['Sales Navigator URL']), /sales\/company\/67890/);
    assertValidZip(buffer);
  });

  await check('company search URLs encode filters and chunk at 50 companies', async () => {
    const { buildCompanySearchUrls } = await import('../src/utils/salesnav-url');

    const one = buildCompanySearchUrls([{ id: '162479', text: 'Apple Inc.' }]);
    assert.equal(one.length, 1);
    assert.match(one[0].url, /^https:\/\/www\.linkedin\.com\/sales\/search\/people\?query=/);
    assert.match(one[0].url, /CURRENT_COMPANY/);
    assert.match(one[0].url, /id%3A162479/);
    // Space double-encodes to %2520; dot passes through encodeURIComponent.
    assert.match(one[0].url, /Apple%2520Inc\./);
    assert.deepEqual(one[0].companies, ['Apple Inc.']);

    const many = buildCompanySearchUrls(
      Array.from({ length: 120 }, (_, i) => ({ id: `${i}`, text: `Co ${i}` })),
    );
    assert.equal(many.length, 3);
    assert.equal(many[0].companies.length, 50);
    assert.equal(many[2].companies.length, 20);
  });

  await check('cleanCompanyName strips legal suffixes and parentheticals', async () => {
    const { cleanCompanyName } = await import('../src/utils/worker-api');
    assert.equal(cleanCompanyName('Acme Payments Ltd.'), 'Acme Payments');
    assert.equal(cleanCompanyName('Sokin Global Holdings Limited'), 'Sokin Global');
    assert.equal(cleanCompanyName('Wise (UK)'), 'Wise');
    assert.equal(cleanCompanyName('Klarna'), 'Klarna');
    // Suffix requires a separator — brand names ending in "co" survive.
    assert.equal(cleanCompanyName('Monzo'), 'Monzo');
  });

  await check('companyWorkbookFilename is filesystem safe', () => {
    const name = companyWorkbookFilename('UK / Fintechs!', '2026-08-01T10:20:30.000Z');
    assert.match(name, /^UK_Fintechs__companies__.*\.xlsx$/);
    assert.ok(!/[/\\:*?"<>|]/.test(name), `unsafe characters in ${name}`);
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
