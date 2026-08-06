/**
 * Turn one scraped row into an EnrichedContact: the LinkedIn profile only.
 *
 * Posts, comments and reactions are deliberately NOT fetched — the export is
 * built from the personal and company profiles alone, and each activity
 * endpoint was a paginated HarvestAPI call per contact.
 *
 * A failure on any single HarvestAPI call is recorded on the contact and the
 * rest of the enrichment continues — one dead profile must never sink a chunk,
 * and a partially-enriched row is still worth scoring and exporting.
 */

import { HarvestClient } from './harvest';
import type {
  EnrichedContact,
  HarvestCompany,
  HarvestExperience,
  HarvestProfile,
  InboundContact,
} from './harvest-types';

export interface EnrichOptions {
  /** Base URL of the enrichment worker (no trailing slash). */
  workerUrl: string;
  /** The user's bearer token — the HarvestAPI key stays on the worker. */
  apiToken: string;
  findEmail: boolean;
}

/**
 * Sales Navigator lead/people URLs embed the member id, which HarvestAPI takes
 * as `profileId`. Everything else is passed through as a plain profile URL.
 * Mirrors the proven mapping in blitz-main/lib/linkedin-url.ts.
 */
export function toHarvestKey(linkedinUrl: string): { type: 'profileId' | 'url'; value: string } {
  const lead = linkedinUrl.match(/\/sales\/lead\/([A-Za-z0-9_-]+)/);
  if (lead) return { type: 'profileId', value: lead[1] };

  const people = linkedinUrl.match(/\/sales\/people\/([A-Za-z0-9_-]+)/);
  if (people) return { type: 'profileId', value: people[1] };

  return { type: 'url', value: linkedinUrl };
}

/** Normalize `currentPosition`, which arrives as an object OR an array. */
export function currentPositions(profile: HarvestProfile | null): HarvestExperience[] {
  if (!profile) return [];
  const current = profile.currentPosition;
  if (Array.isArray(current)) return current.filter(Boolean);
  if (current && typeof current === 'object') return [current];
  // Fall back to the first experience entry with no end date.
  const open = (profile.experience ?? []).filter((e) => !e.endDate?.year);
  return open.length > 0 ? [open[0]] : [];
}

/**
 * The employer to look up on the company endpoint.
 *
 * The docs list `companyUniversalName`, but live profile responses do not
 * include it — in practice the slug parsed out of `companyLinkedinUrl` is what
 * every lookup and the whole dedup cache runs on. Both are handled; do not
 * remove the fallback.
 */
export function companyKeyOf(profile: HarvestProfile | null): string | null {
  for (const position of currentPositions(profile)) {
    if (position.companyUniversalName) return position.companyUniversalName;
    const slug = position.companyLinkedinUrl?.match(/\/company\/([^/?#]+)/)?.[1];
    if (slug) return decodeURIComponent(slug);
  }
  return null;
}

/**
 * Fetch and normalize the profile for one contact.
 *
 * Gets its OWN HarvestClient so `harvestCalls` is an exact per-contact count —
 * a client shared across the concurrency pool would interleave its counter
 * between contacts and report nonsense. Parallelism is bounded by the caller's
 * pool, not by client instances.
 *
 * Never throws: every HarvestAPI failure lands in `errors` so the workbook can
 * report exactly which rows are incomplete and why.
 */
export async function enrichContact(
  contact: InboundContact,
  options: EnrichOptions,
): Promise<EnrichedContact> {
  const client = new HarvestClient({ workerUrl: options.workerUrl, apiToken: options.apiToken });
  const key = toHarvestKey(contact.linkedin_url);
  const errors: string[] = [];

  let profile: HarvestProfile | null = null;
  try {
    profile = await client.getProfile(key, { findEmail: options.findEmail });
    if (!profile) errors.push('profile: no data returned');
  } catch (err) {
    errors.push(`profile: ${message(err)}`);
  }

  return {
    input: contact,
    lookupKey: `${key.type}:${key.value}`,
    profile: profile ? trimProfile(profile) : null,
    companyKey: companyKeyOf(profile),
    errors,
    harvestCalls: client.calls,
  };
}

/**
 * Drop the ~30 profile fields nothing downstream reads (interests, moreProfiles,
 * profileLocales, patents, courses…). Roughly halves the retained profile and
 * keeps a chunk's step return well under the 1 MB ceiling.
 */
function trimProfile(profile: HarvestProfile): HarvestProfile {
  return {
    id: profile.id,
    publicIdentifier: profile.publicIdentifier,
    linkedinUrl: profile.linkedinUrl,
    firstName: profile.firstName,
    lastName: profile.lastName,
    headline: profile.headline,
    about: clip(profile.about ?? '', 4000) || undefined,
    location: profile.location,
    connectionsCount: profile.connectionsCount,
    followerCount: profile.followerCount,
    openToWork: profile.openToWork,
    hiring: profile.hiring,
    premium: profile.premium,
    influencer: profile.influencer,
    verified: profile.verified,
    emails: profile.emails?.slice(0, 3),
    websites: profile.websites?.slice(0, 3),
    companyWebsites: profile.companyWebsites?.slice(0, 3),
    currentPosition: profile.currentPosition,
    experience: profile.experience?.slice(0, 8).map((position) => ({
      ...position,
      description: clip(position.description ?? '', 500) || undefined,
    })),
    education: profile.education?.slice(0, 4),
    skills: profile.skills?.slice(0, 20),
    certifications: profile.certifications?.slice(0, 8),
    languages: profile.languages?.slice(0, 6),
  };
}

function clip(text: string, max: number): string {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Flatten HarvestAPI's `industries`, which arrives as objects in live responses
 * despite the docs promising strings. Shared by the workbook and the scoring
 * dossier so the two can never disagree.
 */
export function industryNames(company: HarvestCompany | null): string[] {
  return (company?.industries ?? [])
    .map((industry) =>
      typeof industry === 'string' ? industry : (industry?.name ?? industry?.title ?? ''),
    )
    .filter((name): name is string => Boolean(name));
}
