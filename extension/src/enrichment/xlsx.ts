/**
 * Workbook builder.
 *
 * Three sheets:
 *   Scored Contacts — one row per person, sorted best fit first
 *   Activity        — one row per post/comment inside the 6-month window
 *   Run Info        — job metadata, the ICP used, and a data-quality summary
 *
 * Rows are emitted one at a time into a streaming zip (see zip.ts) rather than
 * assembled into a document object first. That is not an optimization — a
 * whole-document writer measurably OOMs the 128 MB Worker isolate at roughly
 * 150 contacts, an eighth of the supported job size.
 *
 * Strings are written as inline `t="inlineStr"` cells, never as formulas, so a
 * scraped name like "=HYPERLINK(...)" is inert. (The CSV path in the extension
 * would still need its own guard; this one does not.)
 */

import type { HarvestCompany, HarvestProfile, ScoredContact } from './harvest-types';
import { currentPositions, industryNames } from './enrich';
import { dosStamp, zip, type ZipEntry } from './zip';

export interface WorkbookMeta {
  jobId: string;
  label: string;
  userId: string;
  icp: string;
  model: string;
  createdAt: string;
  finishedAt: string;
}

/** Excel caps a cell at 32767 characters; stay well clear. */
const CELL_MAX = 30000;

export type Cell = string | number;

function cell(value: unknown): Cell {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? value : '';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  const text = String(value);
  return text.length > CELL_MAX ? `${text.slice(0, CELL_MAX)}…` : text;
}

// ─── XML helpers ───

/**
 * Escape for XML and drop characters XML 1.0 forbids outright. Scraped LinkedIn
 * text does carry stray control bytes, and a single one makes Excel reject the
 * whole file as corrupt rather than skipping the cell.
 */
function xml(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code === 0x09 || code === 0x0a || code === 0x0d) {
      out += char;
      continue;
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0xfffe || code === 0xffff) {
      continue;
    }
    switch (char) {
      case '&':
        out += '&amp;';
        break;
      case '<':
        out += '&lt;';
        break;
      case '>':
        out += '&gt;';
        break;
      case '"':
        out += '&quot;';
        break;
      default:
        out += char;
    }
  }
  return out;
}

/** 0 -> A, 25 -> Z, 26 -> AA … */
function colName(index: number): string {
  let name = '';
  let n = index;
  while (n >= 0) {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  }
  return name;
}

function rowXml(cells: Cell[], rowIndex: number, styleId = 0): string {
  const parts: string[] = [`<row r="${rowIndex}">`];
  for (let c = 0; c < cells.length; c++) {
    const value = cells[c];
    if (value === '' || value === undefined || value === null) continue;
    const ref = `${colName(c)}${rowIndex}`;
    const style = styleId ? ` s="${styleId}"` : '';
    if (typeof value === 'number') {
      parts.push(`<c r="${ref}"${style}><v>${value}</v></c>`);
    } else {
      parts.push(
        `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`,
      );
    }
  }
  parts.push('</row>');
  return parts.join('');
}

interface SheetSpec {
  columns: { header: string; width: number }[];
  /** Lazily produced so a 40 000-row sheet never exists in memory at once. */
  rows: () => Iterable<Cell[]>;
  rowCount: number;
  freezeHeader: boolean;
  autoFilter: boolean;
}

function* sheetXml(spec: SheetSpec): Generator<string> {
  const lastCol = colName(Math.max(0, spec.columns.length - 1));
  const lastRow = spec.rowCount + 1;

  yield '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<dimension ref="A1:${lastCol}${lastRow}"/>`;

  yield spec.freezeHeader
    ? '<sheetViews><sheetView workbookViewId="0">' +
      '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
      '</sheetView></sheetViews>'
    : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';

  yield '<sheetFormatPr defaultRowHeight="15"/>';

  if (spec.columns.length > 0) {
    const cols = spec.columns
      .map((column, index) => `<col min="${index + 1}" max="${index + 1}" width="${column.width}" customWidth="1"/>`)
      .join('');
    yield `<cols>${cols}</cols>`;
  }

  yield '<sheetData>';
  // Style 1 is the bold header defined in styles.xml.
  yield rowXml(spec.columns.map((column) => column.header), 1, 1);

  let rowIndex = 2;
  for (const row of spec.rows()) {
    yield rowXml(row, rowIndex++);
  }
  yield '</sheetData>';

  // Schema order: autoFilter comes after sheetData, not before.
  if (spec.autoFilter && spec.rowCount > 0) {
    yield `<autoFilter ref="A1:${lastCol}${lastRow}"/>`;
  }

  yield '</worksheet>';
}

// ─── Field extraction ───

function locationOf(profile: HarvestProfile | null): string {
  if (!profile?.location) return '';
  if (typeof profile.location === 'string') return profile.location;
  return profile.location.linkedinText ?? '';
}

function primaryEmail(profile: HarvestProfile | null): { email: string; status: string } {
  const entries = profile?.emails ?? [];
  for (const entry of entries) {
    if (typeof entry === 'string' && entry) return { email: entry, status: '' };
    if (entry && typeof entry === 'object' && entry.email) {
      return { email: entry.email, status: entry.status ?? (entry.deliverable ? 'deliverable' : '') };
    }
  }
  return { email: '', status: '' };
}

function employeeCountOf(company: HarvestCompany | null): Cell {
  if (!company) return '';
  if (typeof company.employeeCount === 'number') return company.employeeCount;
  const range = company.employeeCountRange;
  if (range?.start || range?.end) return `${range?.start ?? '?'}-${range?.end ?? '?'}`;
  return '';
}

function headquartersOf(company: HarvestCompany | null): string {
  const locations = company?.locations ?? [];
  const hq = locations.find((l) => l.headquarter) ?? locations[0];
  if (!hq) return '';
  return [hq.city, hq.country].filter(Boolean).join(', ');
}

function tenureMonths(profile: HarvestProfile | null, now: number): Cell {
  const [position] = currentPositions(profile);
  const year = position?.startDate?.year;
  if (!year) return '';
  const month = position.startDate?.month ?? 1;
  const start = Date.UTC(year, Math.max(0, month - 1), 1);
  const months = Math.round((now - start) / (30.44 * 24 * 60 * 60 * 1000));
  return months >= 0 ? months : '';
}

const CONTACT_COLUMNS: { header: string; width: number }[] = [
  { header: 'Fit Score', width: 10 },
  { header: 'Tier', width: 6 },
  { header: 'Verdict', width: 14 },
  { header: 'Confidence', width: 11 },
  { header: 'Name', width: 24 },
  { header: 'Title', width: 34 },
  { header: 'Company', width: 26 },
  { header: 'Seniority', width: 16 },
  { header: 'Buying Role', width: 16 },
  { header: 'Rationale', width: 60 },
  { header: 'Positive Signals', width: 50 },
  { header: 'Risks', width: 44 },
  { header: 'Activity Themes', width: 36 },
  { header: 'Personalized Hook', width: 60 },
  { header: 'Recommended Channel', width: 20 },

  { header: 'Posts (6mo)', width: 12 },
  { header: 'Original Posts', width: 14 },
  { header: 'Reposts', width: 9 },
  { header: 'Comments (6mo)', width: 15 },
  { header: 'Reactions (recent)', width: 17 },
  { header: 'Total Engagement', width: 17 },
  { header: 'Avg Engagement/Post', width: 19 },
  { header: 'Posts / Month', width: 13 },
  { header: 'Last Activity', width: 22 },
  { header: 'Active in Window', width: 16 },

  { header: 'Headline', width: 44 },
  { header: 'About', width: 60 },
  { header: 'Location', width: 26 },
  { header: 'Followers', width: 11 },
  { header: 'Connections', width: 12 },
  { header: 'Open To Work', width: 13 },
  { header: 'Hiring', width: 8 },
  { header: 'Premium', width: 9 },
  { header: 'Current Role', width: 34 },
  { header: 'Current Company', width: 26 },
  { header: 'Tenure (months)', width: 15 },
  { header: 'Top Skills', width: 44 },
  { header: 'Education', width: 40 },
  { header: 'Email', width: 30 },
  { header: 'Email Status', width: 14 },

  { header: 'Company Industry', width: 26 },
  { header: 'Company Employees', width: 18 },
  { header: 'Company Size Range', width: 18 },
  { header: 'Company Followers', width: 17 },
  { header: 'Company Type', width: 16 },
  { header: 'Company Founded', width: 15 },
  { header: 'Company HQ', width: 26 },
  { header: 'Company Website', width: 34 },
  { header: 'Company Specialities', width: 50 },
  { header: 'Company Description', width: 60 },
  { header: 'Company LinkedIn', width: 40 },

  { header: 'LinkedIn URL', width: 46 },
  { header: 'Sales Nav URL', width: 46 },
  { header: 'Public Identifier', width: 24 },
  { header: 'Harvest Calls', width: 13 },
  { header: 'Data Gaps', width: 44 },
];

function contactRow(item: ScoredContact, now: number): Cell[] {
  const { enriched, company, score, scoreError } = item;
  const { profile, activity, input } = enriched;
  const [position] = currentPositions(profile);
  const email = primaryEmail(profile);

  const skills = (profile?.skills ?? [])
    .map((s) => s.name)
    .filter(Boolean)
    .slice(0, 12)
    .join(', ');

  const education = (profile?.education ?? [])
    .slice(0, 3)
    .map((school) => [school.schoolName, school.degree, school.fieldOfStudy].filter(Boolean).join(' — '))
    .join(' | ');

  const founded = company?.foundedOn?.year ? String(company.foundedOn.year) : '';

  const gaps = [...enriched.errors];
  if (scoreError) gaps.push(`scoring: ${scoreError}`);

  return [
    cell(score?.fit_score ?? ''),
    cell(score?.tier ?? ''),
    cell(score?.verdict ?? (scoreError ? 'scoring_failed' : '')),
    cell(score?.confidence ?? ''),
    cell([profile?.firstName, profile?.lastName].filter(Boolean).join(' ') || input.name || ''),
    cell(position?.position || input.title || profile?.headline || ''),
    cell(company?.name || position?.companyName || input.company || ''),
    cell(score?.seniority ?? ''),
    cell(score?.buying_role ?? ''),
    cell(score?.rationale ?? ''),
    cell((score?.positive_signals ?? []).join(' | ')),
    cell((score?.risks ?? []).join(' | ')),
    cell((score?.activity_themes ?? []).join(' | ')),
    cell(score?.personalized_hook ?? ''),
    cell(score?.recommended_channel ?? ''),

    cell(activity.postCount),
    cell(activity.originalPostCount),
    cell(activity.repostCount),
    cell(activity.commentCount),
    cell(activity.reactionCount),
    cell(activity.totalEngagement),
    cell(activity.avgEngagementPerPost),
    cell(activity.postsPerMonth),
    cell(activity.lastActivityIso ?? ''),
    cell(activity.isActive),

    cell(profile?.headline ?? ''),
    cell(profile?.about ?? ''),
    cell(locationOf(profile) || input.location || ''),
    cell(profile?.followerCount ?? ''),
    cell(profile?.connectionsCount ?? ''),
    cell(profile?.openToWork ?? ''),
    cell(profile?.hiring ?? ''),
    cell(profile?.premium ?? ''),
    cell(position?.position ?? ''),
    cell(position?.companyName ?? ''),
    cell(tenureMonths(profile, now)),
    cell(skills),
    cell(education),
    cell(email.email),
    cell(email.status),

    cell(industryNames(company).join(', ')),
    cell(employeeCountOf(company)),
    cell(
      company?.employeeCountRange
        ? `${company.employeeCountRange.start ?? '?'}-${company.employeeCountRange.end ?? '?'}`
        : '',
    ),
    cell(company?.followerCount ?? ''),
    cell(company?.companyType ?? ''),
    cell(founded),
    cell(headquartersOf(company)),
    cell(company?.website ?? ''),
    cell((company?.specialities ?? []).join(', ')),
    cell(company?.description ?? ''),
    cell(company?.linkedinUrl ?? ''),

    cell(profile?.linkedinUrl ?? ''),
    cell(input.linkedin_url),
    cell(profile?.publicIdentifier ?? ''),
    cell(enriched.harvestCalls),
    cell(gaps.join(' | ')),
  ];
}

const ACTIVITY_COLUMNS: { header: string; width: number }[] = [
  { header: 'Name', width: 24 },
  { header: 'Company', width: 26 },
  { header: 'Type', width: 10 },
  { header: 'Date', width: 22 },
  { header: 'Engagement', width: 12 },
  { header: 'Likes', width: 8 },
  { header: 'Comments', width: 10 },
  { header: 'Shares', width: 8 },
  { header: 'Text', width: 90 },
  { header: 'URL', width: 46 },
  { header: 'Sales Nav URL', width: 46 },
];

function* activityRows(items: ScoredContact[]): Generator<Cell[]> {
  for (const item of items) {
    const { enriched, company } = item;
    const name =
      [enriched.profile?.firstName, enriched.profile?.lastName].filter(Boolean).join(' ') ||
      enriched.input.name ||
      '';
    const companyName = company?.name || enriched.input.company || '';

    for (const post of enriched.posts) {
      yield [
        cell(name),
        cell(companyName),
        cell(post.isRepost ? 'repost' : 'post'),
        cell(post.postedAtIso ?? ''),
        cell(post.totalEngagement),
        cell(post.likes),
        cell(post.comments),
        cell(post.shares),
        cell(post.text),
        cell(post.url),
        cell(enriched.input.linkedin_url),
      ];
    }

    for (const comment of enriched.comments) {
      yield [
        cell(name),
        cell(companyName),
        cell('comment'),
        cell(comment.postedAtIso ?? ''),
        '',
        '',
        '',
        '',
        cell(comment.text),
        cell(comment.url),
        cell(enriched.input.linkedin_url),
      ];
    }
  }
}

function countActivityRows(items: ScoredContact[]): number {
  let total = 0;
  for (const item of items) {
    total += item.enriched.posts.length + item.enriched.comments.length;
  }
  return total;
}

// ─── Static OOXML parts ───

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '</Types>';

const ROOT_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  '</Relationships>';

const WORKBOOK_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
  '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>' +
  '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>' +
  '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  '</Relationships>';

const SHEET_NAMES = ['Scored Contacts', 'Activity', 'Run Info'];

const WORKBOOK =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
  SHEET_NAMES.map(
    (name, index) => `<sheet name="${xml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
  ).join('') +
  '</sheets></workbook>';

// Two cell formats: 0 = default, 1 = bold (the header row).
const STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>' +
  '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>' +
  '<borders count="1"><border/></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
  '</styleSheet>';

// ─── Public API ───

/**
 * Build the .xlsx. Async because compression is streamed.
 * `now` is the job's deterministic clock — it also stamps the archive, so a
 * replayed workflow step produces a byte-identical file.
 */
export async function buildWorkbook(
  items: ScoredContact[],
  meta: WorkbookMeta,
  now: number,
): Promise<Uint8Array> {
  // Best fit first; unscored rows sink to the bottom rather than reading as 0.
  const sorted = [...items].sort((a, b) => {
    const left = a.score?.fit_score ?? -1;
    const right = b.score?.fit_score ?? -1;
    return right - left;
  });

  const scored = items.filter((i) => i.score).length;
  const withProfile = items.filter((i) => i.enriched.profile).length;
  const withCompany = items.filter((i) => i.company).length;
  const withActivity = items.filter((i) => i.enriched.activity.isActive).length;
  const tierCount = (tier: string) => items.filter((i) => i.score?.tier === tier).length;
  const harvestCalls = items.reduce((sum, i) => sum + i.enriched.harvestCalls, 0);

  const infoRows: Cell[][] = [
    ['Label', meta.label],
    ['Requested by', meta.userId],
    ['Created (UTC)', meta.createdAt],
    ['Finished (UTC)', meta.finishedAt],
    ['Scoring model', meta.model],
    ['Activity window', '6 months'],
    ['', ''],
    ['Contacts submitted', items.length],
    ['Profile resolved', withProfile],
    ['Company resolved', withCompany],
    ['Active on LinkedIn (6mo)', withActivity],
    ['Successfully scored', scored],
    ['Scoring failed', items.length - scored],
    ['HarvestAPI calls', harvestCalls],
    ['', ''],
    ['Tier A (80-100)', tierCount('A')],
    ['Tier B (60-79)', tierCount('B')],
    ['Tier C (40-59)', tierCount('C')],
    ['Tier D (0-39)', tierCount('D')],
    ['', ''],
    ['ICP used for scoring', meta.icp],
  ];

  const sheets: SheetSpec[] = [
    {
      columns: CONTACT_COLUMNS,
      rows: () => sorted.map((item) => contactRow(item, now)),
      rowCount: sorted.length,
      freezeHeader: true,
      autoFilter: true,
    },
    {
      columns: ACTIVITY_COLUMNS,
      rows: () => activityRows(sorted),
      rowCount: countActivityRows(sorted),
      freezeHeader: true,
      autoFilter: true,
    },
    {
      columns: [
        { header: 'Job ID', width: 30 },
        { header: meta.jobId, width: 110 },
      ],
      rows: () => infoRows,
      rowCount: infoRows.length,
      freezeHeader: false,
      autoFilter: false,
    },
  ];

  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', chunks: () => [CONTENT_TYPES] },
    { name: '_rels/.rels', chunks: () => [ROOT_RELS] },
    { name: 'xl/workbook.xml', chunks: () => [WORKBOOK] },
    { name: 'xl/_rels/workbook.xml.rels', chunks: () => [WORKBOOK_RELS] },
    { name: 'xl/styles.xml', chunks: () => [STYLES] },
    ...sheets.map((spec, index) => ({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      chunks: () => sheetXml(spec),
    })),
  ];

  return zip(entries, dosStamp(new Date(now)));
}

/** Filesystem-safe workbook name. */
export function workbookFilename(label: string, jobId: string, createdAt: string): string {
  const slug =
    (label || 'salesnav')
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 50) || 'salesnav';
  const stamp = createdAt.replace(/[:.]/g, '-').replace(/T/, '_').slice(0, 19);
  return `${slug}__${stamp}__${jobId.slice(0, 8)}.xlsx`;
}
