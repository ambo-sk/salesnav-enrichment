/**
 * Workbook builder.
 *
 * Two sheets:
 *   Scored Contacts — one row per person, sorted best fit first
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
import { currentPositions } from './enrich';
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

function officeOf(location: NonNullable<HarvestCompany['locations']>[number]): string {
  return [location.city, location.geographicArea, location.country].filter(Boolean).join(', ');
}

function headquartersOf(company: HarvestCompany | null): string {
  const locations = company?.locations ?? [];
  const hq = locations.find((l) => l.headquarter) ?? locations[0];
  return hq ? officeOf(hq) : '';
}

/** Every office, HQ first, deduped — the HQ line repeats in `locations`. */
function officesOf(company: HarvestCompany | null): string {
  const seen = new Set<string>();
  for (const location of company?.locations ?? []) {
    const text = officeOf(location);
    if (text) seen.add(text);
  }
  return [...seen].join(' | ');
}

/**
 * Every role the person still holds, as "Company — Title (start year)".
 *
 * `currentPosition` alone under-reports: it carries one entry on most live
 * responses, so open-ended `experience` rows are merged in and deduped by
 * company + role.
 */
function currentExperiences(profile: HarvestProfile | null): string {
  const open = [
    ...currentPositions(profile),
    ...(profile?.experience ?? []).filter((e) => !e.endDate?.year),
  ];

  const seen = new Map<string, string>();
  for (const position of open) {
    const company = position.companyName ?? '';
    const role = position.position ?? '';
    if (!company && !role) continue;
    const year = position.startDate?.year;
    const who = company && role ? `${company} — ${role}` : company || role;
    const label = [who, year ? `(${year})` : ''].filter(Boolean).join(' ');
    seen.set(`${company.toLowerCase()}|${role.toLowerCase()}`, label);
  }
  return [...seen.values()].join(' | ');
}

/** "Jane Doe" -> first "Jane", last "Doe". Only used when the profile lookup
 *  failed and the scraped row is all we have. */
function splitName(name: string): { first: string; last: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: '', last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
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
  { header: 'Personal Linkedin URL', width: 46 },
  { header: 'First Name', width: 18 },
  { header: 'Last Name', width: 20 },
  { header: 'Job Title', width: 34 },
  { header: 'Company Name', width: 26 },
  { header: 'Website', width: 34 },
  { header: 'Company Type', width: 16 },
  { header: 'Company HQ', width: 26 },
  { header: 'Company offices', width: 50 },
  { header: 'Company Linkedin URL', width: 40 },
  { header: 'Email', width: 34 },
  { header: 'Direct Phone', width: 22 },
  { header: 'Mobile Phone', width: 22 },
  { header: 'Contact Accuracy', width: 16 },
  { header: 'Personalized Hook', width: 60 },
  { header: 'Top Skills', width: 44 },
  { header: 'Tenure (months)', width: 15 },
  { header: 'Rationale', width: 60 },
  { header: 'Current Experiences', width: 60 },
];

/**
 * Phone numbers carry their do-not-call status into the cell. Similarweb
 * returns the flag as a sibling field, and a number exported without it reads
 * as callable — whoever works the sheet has to see the restriction.
 */
function phoneList(numbers: string[], doNotCall: boolean | null): string {
  if (numbers.length === 0) return '';
  const joined = numbers.join(', ');
  return doNotCall ? `${joined} (DNC)` : joined;
}

function contactRow(item: ScoredContact, now: number): Cell[] {
  const { enriched, company, score, contact } = item;
  const { profile, input } = enriched;
  const [position] = currentPositions(profile);
  const scraped = splitName(input.name ?? '');

  const skills = (profile?.skills ?? [])
    .map((s) => s.name)
    .filter(Boolean)
    .slice(0, 12)
    .join(', ');

  return [
    cell(profile?.linkedinUrl || input.linkedin_url),
    cell(profile?.firstName || scraped.first),
    cell(profile?.lastName || scraped.last),
    cell(position?.position || input.title || profile?.headline || ''),
    cell(company?.name || position?.companyName || input.company || ''),
    cell(company?.website ?? ''),
    cell(company?.companyType ?? ''),
    cell(headquartersOf(company)),
    cell(officesOf(company)),
    cell(company?.linkedinUrl ?? ''),
    cell((contact?.emails ?? []).join(', ')),
    cell(phoneList(contact?.directPhones ?? [], contact?.directPhoneDoNotCall ?? null)),
    cell(phoneList(contact?.mobilePhones ?? [], contact?.mobilePhoneDoNotCall ?? null)),
    cell(contact?.accuracyScore ?? ''),
    cell(score?.personalized_hook ?? ''),
    cell(skills),
    cell(tenureMonths(profile, now)),
    cell(score?.rationale ?? ''),
    cell(currentExperiences(profile)),
  ];
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
  '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
  '</Relationships>';

const SHEET_NAMES = ['Scored Contacts', 'Run Info'];

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
  const tierCount = (tier: string) => items.filter((i) => i.score?.tier === tier).length;
  const harvestCalls = items.reduce((sum, i) => sum + i.enriched.harvestCalls, 0);

  const infoRows: Cell[][] = [
    ['Label', meta.label],
    ['Requested by', meta.userId],
    ['Created (UTC)', meta.createdAt],
    ['Finished (UTC)', meta.finishedAt],
    ['Scoring model', meta.model],
    ['', ''],
    ['Contacts submitted', items.length],
    ['Profile resolved', withProfile],
    ['Company resolved', withCompany],
    ['Email found', items.filter((i) => (i.contact?.emails.length ?? 0) > 0).length],
    [
      'Phone found',
      items.filter(
        (i) => (i.contact?.directPhones.length ?? 0) + (i.contact?.mobilePhones.length ?? 0) > 0,
      ).length,
    ],
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
