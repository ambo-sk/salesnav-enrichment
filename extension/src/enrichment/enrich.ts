/**
 * Turn one scraped row into an EnrichedContact: profile + 6 months of activity,
 * normalized and summarized.
 *
 * A failure on any single HarvestAPI call is recorded on the contact and the
 * rest of the enrichment continues — one dead profile must never sink a chunk,
 * and a partially-enriched row is still worth scoring and exporting.
 */

import { HarvestClient } from './harvest';
import type {
  ActivityStats,
  EnrichedContact,
  HarvestComment,
  HarvestCompany,
  HarvestExperience,
  HarvestPost,
  HarvestProfile,
  InboundContact,
  NormalizedComment,
  NormalizedPost,
} from './harvest-types';

export const ACTIVITY_WINDOW_MONTHS = 6;
const ACTIVITY_WINDOW_MS = ACTIVITY_WINDOW_MONTHS * 30.44 * 24 * 60 * 60 * 1000;

/**
 * Retention caps applied AFTER the activity stats are computed, so the counts
 * in the workbook still reflect everything HarvestAPI returned while the
 * retained payload stays bounded.
 *
 * Two ceilings force this: a Workflow step may return at most 1 MB, and a
 * 1000-contact run holds every enriched record in Worker memory (128 MB) until
 * the workbook is written.
 *
 * The caps are set at what the scorer actually reads (openrouter.ts LIMITS uses
 * 15 posts x 600 chars, 10 comments x 300) plus a small margin for the Activity
 * sheet. Retaining more than the consumer reads buys nothing and costs memory
 * on every one of 1000 contacts.
 */
const RETAIN = {
  posts: 15,
  comments: 10,
  postTextChars: 800,
  commentTextChars: 400,
};

export interface EnrichOptions {
  /** Base URL of the enrichment worker (no trailing slash). */
  workerUrl: string;
  /** The user's bearer token — the HarvestAPI key stays on the worker. */
  apiToken: string;
  maxPostPages: number;
  maxCommentPages: number;
  maxReactionPages: number;
  includeReactions: boolean;
  findEmail: boolean;
  /** Epoch ms the 6-month window is measured back from. Passed in (never
   *  Date.now() inside a step) so a workflow retry re-derives the same window. */
  now: number;
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

/** HarvestAPI `postedAt` is either `{timestamp,date}` or a bare date string. */
function postedAtMs(postedAt: HarvestPost['postedAt']): number | null {
  if (!postedAt) return null;
  if (typeof postedAt === 'string') {
    const parsed = Date.parse(postedAt);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof postedAt.timestamp === 'number' && postedAt.timestamp > 0) {
    // Some feeds report seconds rather than milliseconds.
    return postedAt.timestamp < 1e12 ? postedAt.timestamp * 1000 : postedAt.timestamp;
  }
  if (postedAt.date) {
    const parsed = Date.parse(postedAt.date);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizePost(post: HarvestPost): NormalizedPost {
  const ms = postedAtMs(post.postedAt);
  const engagement = post.engagement ?? {};
  const likes = engagement.likes ?? engagement.reactions ?? 0;
  const comments = engagement.comments ?? 0;
  const shares = engagement.shares ?? 0;

  return {
    url: post.linkedinUrl ?? '',
    postedAtIso: ms ? new Date(ms).toISOString() : null,
    postedAtMs: ms,
    isRepost: Boolean(post.repost || post.repostId),
    text: (post.content ?? '').trim(),
    likes,
    comments,
    shares,
    totalEngagement: likes + comments + shares,
  };
}

function normalizeComment(comment: HarvestComment): NormalizedComment {
  const ms =
    typeof comment.createdAtTimestamp === 'number' && comment.createdAtTimestamp > 0
      ? comment.createdAtTimestamp < 1e12
        ? comment.createdAtTimestamp * 1000
        : comment.createdAtTimestamp
      : comment.createdAt
        ? Date.parse(comment.createdAt) || null
        : null;

  return {
    url: comment.linkedinUrl ?? '',
    postedAtIso: ms ? new Date(ms).toISOString() : null,
    postedAtMs: ms,
    text: (comment.commentary ?? '').trim(),
  };
}

/**
 * Keep items dated inside the window. Undated items are KEPT: HarvestAPI
 * already applied its own `scrapePostedLimit=6months` server-side for posts,
 * so dropping the ones it failed to timestamp would discard real activity.
 */
function withinWindow<T extends { postedAtMs: number | null }>(items: T[], now: number): T[] {
  const cutoff = now - ACTIVITY_WINDOW_MS;
  return items.filter((item) => item.postedAtMs === null || item.postedAtMs >= cutoff);
}

export function summarizeActivity(
  posts: NormalizedPost[],
  comments: NormalizedComment[],
  reactionCount: number,
): ActivityStats {
  const originalPostCount = posts.filter((p) => !p.isRepost).length;
  const totalEngagement = posts.reduce((sum, p) => sum + p.totalEngagement, 0);

  const timestamps = [...posts, ...comments]
    .map((item) => item.postedAtMs)
    .filter((ms): ms is number => ms !== null);
  const lastActivityMs = timestamps.length > 0 ? Math.max(...timestamps) : null;

  return {
    windowMonths: ACTIVITY_WINDOW_MONTHS,
    postCount: posts.length,
    originalPostCount,
    repostCount: posts.length - originalPostCount,
    commentCount: comments.length,
    reactionCount,
    totalEngagement,
    avgEngagementPerPost:
      posts.length > 0 ? Math.round((totalEngagement / posts.length) * 10) / 10 : 0,
    lastActivityIso: lastActivityMs ? new Date(lastActivityMs).toISOString() : null,
    postsPerMonth: Math.round((posts.length / ACTIVITY_WINDOW_MONTHS) * 10) / 10,
    isActive: posts.length > 0 || comments.length > 0,
  };
}

/**
 * Fetch and normalize everything for one contact.
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

  // Activity lookups reuse the profile id when Harvest resolved one — it is the
  // faster key, and it still works when the input was a plain /in/ URL.
  const activityKey: { type: 'profileId' | 'url'; value: string } = profile?.id
    ? { type: 'profileId', value: profile.id }
    : key;

  const [rawPosts, rawComments, rawReactions] = await Promise.all([
    client
      .getProfilePosts(activityKey, { maxPages: options.maxPostPages })
      .catch((err) => {
        errors.push(`posts: ${message(err)}`);
        return [] as HarvestPost[];
      }),
    client
      .getProfileComments(activityKey, { maxPages: options.maxCommentPages })
      .catch((err) => {
        errors.push(`comments: ${message(err)}`);
        return [] as HarvestComment[];
      }),
    options.includeReactions
      ? client
          .getProfileReactions(activityKey, { maxPages: options.maxReactionPages })
          .catch((err) => {
            errors.push(`reactions: ${message(err)}`);
            return [];
          })
      : Promise.resolve([]),
  ]);

  const posts = withinWindow(rawPosts.map(normalizePost), options.now).sort(
    (a, b) => (b.postedAtMs ?? 0) - (a.postedAtMs ?? 0),
  );
  const comments = withinWindow(rawComments.map(normalizeComment), options.now).sort(
    (a, b) => (b.postedAtMs ?? 0) - (a.postedAtMs ?? 0),
  );

  // Stats first (over everything), retention second (bounded payload).
  const activity = summarizeActivity(posts, comments, rawReactions.length);

  return {
    input: contact,
    lookupKey: `${key.type}:${key.value}`,
    profile: profile ? trimProfile(profile) : null,
    companyKey: companyKeyOf(profile),
    posts: posts.slice(0, RETAIN.posts).map((post) => ({
      ...post,
      text: clip(post.text, RETAIN.postTextChars),
    })),
    comments: comments.slice(0, RETAIN.comments).map((comment) => ({
      ...comment,
      text: clip(comment.text, RETAIN.commentTextChars),
    })),
    activity,
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
