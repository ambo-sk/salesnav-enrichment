/**
 * Builds the plain-text dossier the scorer reads.
 *
 * Lives in the extension because it needs the enriched contact, which never
 * leaves the browser. The prompt, the ICP and the model stay on the worker —
 * the extension POSTs this text to /proxy/score and gets a Score back, so the
 * proxy can never be driven as a general-purpose LLM gateway.
 */

import type { EnrichedContact, HarvestCompany, HarvestProfile } from './harvest-types';
import { currentPositions, industryNames } from './enrich';

// Per-field caps on the dossier. Generous enough to judge fit, small enough
// that 1000 contacts stays affordable.
const LIMITS = {
  about: 1500,
  companyDescription: 1200,
  experience: 6,
  education: 3,
  skills: 15,
  specialities: 15,
};

function truncate(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function locationOf(profile: HarvestProfile | null): string {
  if (!profile?.location) return '';
  if (typeof profile.location === 'string') return profile.location;
  return profile.location.linkedinText ?? '';
}

function formatDate(date?: { month?: number | null; year?: number | null; text?: string | null }): string {
  if (!date) return '';
  if (date.text) return date.text;
  if (!date.year) return '';
  return date.month ? `${String(date.month).padStart(2, '0')}/${date.year}` : String(date.year);
}

/** Human-readable dossier. Plain text beats JSON here: fewer tokens, and the
 *  model does not need to re-derive structure it will not echo back. */
export function buildDossier(enriched: EnrichedContact, company: HarvestCompany | null): string {
  const { input, profile } = enriched;
  const lines: string[] = [];

  lines.push('## SCRAPED FROM SALES NAVIGATOR');
  lines.push(`Name: ${input.name || '(unknown)'}`);
  if (input.title) lines.push(`Title: ${input.title}`);
  if (input.company) lines.push(`Company: ${input.company}`);
  if (input.location) lines.push(`Location: ${input.location}`);

  lines.push('');
  lines.push('## LINKEDIN PROFILE');
  if (!profile) {
    lines.push('(profile lookup failed or returned no data)');
  } else {
    const name = [profile.firstName, profile.lastName].filter(Boolean).join(' ');
    if (name) lines.push(`Name: ${name}`);
    if (profile.headline) lines.push(`Headline: ${profile.headline}`);
    const loc = locationOf(profile);
    if (loc) lines.push(`Location: ${loc}`);
    if (typeof profile.followerCount === 'number') lines.push(`Followers: ${profile.followerCount}`);
    if (typeof profile.connectionsCount === 'number') {
      lines.push(`Connections: ${profile.connectionsCount}`);
    }
    const flags = [
      profile.openToWork ? 'open to work' : '',
      profile.hiring ? 'hiring' : '',
      profile.premium ? 'premium' : '',
      profile.influencer ? 'influencer' : '',
    ].filter(Boolean);
    if (flags.length) lines.push(`Flags: ${flags.join(', ')}`);

    const about = truncate(profile.about, LIMITS.about);
    if (about) lines.push(`About: ${about}`);

    const current = currentPositions(profile);
    if (current.length) {
      lines.push('Current role(s):');
      for (const position of current) {
        const range = [formatDate(position.startDate), formatDate(position.endDate) || 'present']
          .filter(Boolean)
          .join(' - ');
        lines.push(
          `  - ${position.position ?? '(role)'} @ ${position.companyName ?? '(company)'}${range ? ` (${range})` : ''}`,
        );
      }
    }

    const history = (profile.experience ?? []).slice(0, LIMITS.experience);
    if (history.length) {
      lines.push('Experience:');
      for (const position of history) {
        const range = [formatDate(position.startDate), formatDate(position.endDate) || 'present']
          .filter(Boolean)
          .join(' - ');
        lines.push(
          `  - ${position.position ?? '(role)'} @ ${position.companyName ?? '(company)'}${range ? ` (${range})` : ''}`,
        );
      }
    }

    const education = (profile.education ?? []).slice(0, LIMITS.education);
    if (education.length) {
      lines.push('Education:');
      for (const school of education) {
        const detail = [school.degree, school.fieldOfStudy].filter(Boolean).join(', ');
        lines.push(`  - ${school.schoolName ?? '(school)'}${detail ? ` — ${detail}` : ''}`);
      }
    }

    const skills = (profile.skills ?? [])
      .map((skill) => skill.name)
      .filter((name): name is string => Boolean(name))
      .slice(0, LIMITS.skills);
    if (skills.length) lines.push(`Skills: ${skills.join(', ')}`);
  }

  lines.push('');
  lines.push('## COMPANY');
  if (!company) {
    lines.push('(company lookup failed, not attempted, or returned no data)');
  } else {
    if (company.name) lines.push(`Name: ${company.name}`);
    if (company.tagline) lines.push(`Tagline: ${company.tagline}`);
    if (company.website) lines.push(`Website: ${company.website}`);
    const industries = industryNames(company);
    if (industries.length) lines.push(`Industries: ${industries.join(', ')}`);
    if (typeof company.employeeCount === 'number') {
      lines.push(`Employees: ${company.employeeCount}`);
    } else if (company.employeeCountRange) {
      const { start, end } = company.employeeCountRange;
      lines.push(`Employees: ${start ?? '?'}-${end ?? '?'}`);
    }
    if (typeof company.followerCount === 'number') {
      lines.push(`LinkedIn followers: ${company.followerCount}`);
    }
    if (company.companyType) lines.push(`Type: ${company.companyType}`);
    const founded = formatDate(company.foundedOn);
    if (founded) lines.push(`Founded: ${founded}`);
    const hq = (company.locations ?? []).find((l) => l.headquarter) ?? company.locations?.[0];
    if (hq) lines.push(`HQ: ${[hq.city, hq.country].filter(Boolean).join(', ')}`);
    // Offices across several countries are the strongest cross-border tell the
    // record carries, and the ICP scores on it.
    const offices = new Set(
      (company.locations ?? [])
        .map((l) => [l.city, l.geographicArea, l.country].filter(Boolean).join(', '))
        .filter(Boolean),
    );
    if (offices.size) lines.push(`Offices: ${[...offices].slice(0, 20).join(' | ')}`);
    if (company.specialities?.length) {
      lines.push(`Specialities: ${company.specialities.slice(0, LIMITS.specialities).join(', ')}`);
    }
    const description = truncate(company.description, LIMITS.companyDescription);
    if (description) lines.push(`Description: ${description}`);
  }

  if (enriched.errors.length) {
    lines.push('');
    lines.push(`## DATA GAPS\n${enriched.errors.map((e) => `  - ${e}`).join('\n')}`);
  }

  return lines.join('\n');
}
