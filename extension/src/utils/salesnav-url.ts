/**
 * Sales Navigator people-search URL builder for a CURRENT_COMPANY filter.
 *
 * Minimal port of the hw_salesnav_chat URL builder — only the company filter,
 * since scraped company lists are all this extension feeds it. The query syntax
 * is LinkedIn's double-encoded `(type:...,values:List(...))` format.
 */

export interface ResolvedCompany {
  id: string;
  text: string;
}

/** LinkedIn URLs degrade past ~20 company values — split into multiple searches. */
const MAX_COMPANIES_PER_URL = 20;

function encodeFilterValue(company: ResolvedCompany): string {
  const encodedText = encodeURIComponent(company.text).replace(/%20/g, '%2520');
  return `(id%3A${company.id}%2Ctext%3A${encodedText}%2CselectionType%3AINCLUDED)`;
}

function buildUrl(companies: ResolvedCompany[]): string {
  const values = companies.map(encodeFilterValue).join('%2C');
  const block = `(type%3ACURRENT_COMPANY%2Cvalues%3AList(${values}))`;
  return `https://www.linkedin.com/sales/search/people?query=(filters%3AList(${block}))&viewAllFilters=true`;
}

/** One URL per chunk of 20 companies. Add further filters by hand in Sales Nav. */
export function buildCompanySearchUrls(
  companies: ResolvedCompany[],
): { url: string; companies: string[] }[] {
  const urls: { url: string; companies: string[] }[] = [];
  for (let i = 0; i < companies.length; i += MAX_COMPANIES_PER_URL) {
    const chunk = companies.slice(i, i + MAX_COMPANIES_PER_URL);
    urls.push({ url: buildUrl(chunk), companies: chunk.map((c) => c.text) });
  }
  return urls;
}
