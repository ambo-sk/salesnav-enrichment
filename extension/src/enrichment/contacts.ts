/**
 * Similarweb contact enrichment — emails and phone numbers, via the worker proxy.
 *
 * Keyed on the PUBLIC linkedin.com/in/ URL that HarvestAPI returns, not on the
 * scraped Sales Navigator /sales/lead/ URL: the latter carries a member id
 * Similarweb does not index. Contacts whose profile lookup failed have no
 * public URL and are skipped rather than matched by name — see below.
 *
 * The bulk response comes back REORDERED and with misses silently dropped
 * (3 in, 2 out, in a different order — observed, not documented), so rows are
 * joined by normalized URL. Never zip the response against the request by index.
 */

export interface ContactInfo {
  emails: string[];
  directPhones: string[];
  mobilePhones: string[];
  /** Similarweb confidence, 0-100. Null when the field was absent. */
  accuracyScore: number | null;
  directPhoneDoNotCall: boolean | null;
  mobilePhoneDoNotCall: boolean | null;
}

export interface ContactsOptions {
  /** Base URL of the enrichment worker, no trailing slash. */
  workerUrl: string;
  /** The user's bearer token — the Similarweb key stays on the worker. */
  apiToken: string;
}

/** Similarweb's ceiling on the bulk endpoint. The worker enforces it too. */
export const CONTACTS_BATCH_SIZE = 25;

/**
 * Join key for a LinkedIn profile URL: scheme, host prefix, query, trailing
 * slash and case all vary between what we send and what comes back.
 */
export function contactKey(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^[a-z]{2,3}\.linkedin\.com/, 'linkedin.com')
    .replace(/^www\./, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '');
}

function boolOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** Response rows -> normalized-URL -> ContactInfo. Exported for the self-check. */
export function indexContacts(payload: unknown): Map<string, ContactInfo> {
  const rows = (payload as { data?: unknown })?.data;
  const found = new Map<string, ContactInfo>();
  if (!Array.isArray(rows)) return found;

  for (const row of rows) {
    const record = row as Record<string, unknown>;
    // The response spells it `linked_in_url`; the request field is `linkedin_url`.
    const url = record.linked_in_url ?? record.linkedin_url;
    if (typeof url !== 'string' || !url.trim()) continue;

    found.set(contactKey(url), {
      emails: stringList(record.emails),
      directPhones: stringList(record.direct_phones),
      mobilePhones: stringList(record.mobile_phones),
      accuracyScore: typeof record.accuracy_score === 'number' ? record.accuracy_score : null,
      directPhoneDoNotCall: boolOrNull(record.direct_phone_do_not_call),
      mobilePhoneDoNotCall: boolOrNull(record.mobile_phone_do_not_call),
    });
  }

  return found;
}

/**
 * Look up one batch (<= 25 URLs). Throws only on a token failure, which is
 * fatal for every subsequent batch too; every other failure is the caller's
 * cue to leave those rows blank and keep going.
 */
export async function fetchContacts(
  urls: string[],
  options: ContactsOptions,
): Promise<Map<string, ContactInfo>> {
  const wanted = urls.filter((url) => url.trim() !== '').slice(0, CONTACTS_BATCH_SIZE);
  if (wanted.length === 0) return new Map();

  const response = await fetch(`${options.workerUrl}/proxy/contacts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ contacts: wanted.map((url) => ({ linkedin_url: url })) }),
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 200);
    throw new Error(`contacts HTTP ${response.status}: ${detail}`);
  }

  return indexContacts(await response.json());
}
