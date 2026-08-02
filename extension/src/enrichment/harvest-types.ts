/**
 * Types for the client-side enrichment pipeline.
 *
 * The HarvestAPI shapes below are deliberately partial: only the fields this
 * pipeline actually reads are typed. Everything else is carried through as
 * `unknown` rather than being mirrored, so a HarvestAPI field addition can
 * never break a build here.
 */



/** One scraped row as the extension sends it. */
export interface InboundContact {
  linkedin_url: string;
  name?: string;
  title?: string;
  company?: string;
  location?: string;
}

// ─── HarvestAPI (partial) ───

export interface HarvestEnvelope<T> {
  element?: T;
  elements?: T[];
  pagination?: HarvestPagination;
  status?: string;
  error?: string;
}

export interface HarvestPagination {
  totalPages?: number;
  totalElements?: number;
  pageNumber?: number;
  pageSize?: number;
  paginationToken?: string | null;
}

export interface HarvestDate {
  month?: number | null;
  year?: number | null;
  day?: number | null;
  text?: string | null;
}

export interface HarvestExperience {
  position?: string;
  companyName?: string;
  companyLinkedinUrl?: string;
  companyId?: string;
  companyUniversalName?: string;
  employmentType?: string;
  workplaceType?: string;
  location?: string;
  description?: string;
  duration?: string;
  startDate?: HarvestDate;
  endDate?: HarvestDate;
}

export interface HarvestEducation {
  schoolName?: string;
  degree?: string;
  fieldOfStudy?: string;
  period?: string;
  startDate?: HarvestDate;
  endDate?: HarvestDate;
}

export interface HarvestEmail {
  email?: string;
  deliverable?: boolean;
  status?: string;
  qualityScore?: number | string;
}

export interface HarvestProfile {
  id?: string;
  publicIdentifier?: string;
  linkedinUrl?: string;
  firstName?: string;
  lastName?: string;
  headline?: string;
  about?: string;
  location?: { linkedinText?: string; countryCode?: string } | string;
  connectionsCount?: number;
  followerCount?: number;
  openToWork?: boolean;
  hiring?: boolean;
  premium?: boolean;
  influencer?: boolean;
  verified?: boolean;
  emails?: (HarvestEmail | string)[];
  websites?: string[];
  companyWebsites?: string[];
  topSkills?: string[] | string;
  currentPosition?: HarvestExperience[] | HarvestExperience;
  experience?: HarvestExperience[];
  education?: HarvestEducation[];
  skills?: { name?: string; endorsements?: number }[];
  certifications?: { title?: string; issuedBy?: string }[];
  languages?: { name?: string; proficiency?: string }[];
}

export interface HarvestCompany {
  id?: string;
  universalName?: string;
  linkedinUrl?: string;
  name?: string;
  tagline?: string;
  website?: string;
  description?: string;
  companyType?: string;
  employeeCount?: number;
  employeeCountRange?: { start?: number; end?: number };
  followerCount?: number;
  foundedOn?: HarvestDate;
  /**
   * Live responses return objects ({id, name, urn, title, hierarchy}) even
   * though the docs describe a string array. Both shapes are accepted and
   * flattened by `industryNames` — joining the raw array writes
   * "[object Object]" into every row.
   */
  industries?: (string | { name?: string; title?: string })[];
  /** Genuinely a string array in live responses. */
  specialities?: string[];
  locations?: {
    country?: string;
    city?: string;
    geographicArea?: string;
    line1?: string;
    line2?: string;
    postalCode?: string;
    headquarter?: boolean;
    description?: string;
  }[];
  pageVerified?: boolean;
  paidCompany?: boolean;
}

export interface HarvestPost {
  id?: string;
  content?: string;
  linkedinUrl?: string;
  postedAt?: { timestamp?: number; date?: string; postedAgo?: string } | string;
  repostId?: string | null;
  repost?: boolean;
  article?: { title?: string; url?: string } | null;
  engagement?: {
    likes?: number;
    comments?: number;
    shares?: number;
    reactions?: number;
  };
}

export interface HarvestComment {
  id?: string;
  linkedinUrl?: string;
  commentary?: string;
  createdAt?: string;
  createdAtTimestamp?: number;
  numComments?: number;
  postId?: string;
}

export interface HarvestReaction {
  id?: string;
  reactionType?: string;
  postId?: string;
  actor?: { name?: string; linkedinUrl?: string; position?: string };
}

// ─── Normalized pipeline shapes ───

/** Everything gathered for one person, before scoring. */
export interface EnrichedContact {
  input: InboundContact;
  /** HarvestAPI lookup key actually used (sales-nav id or profile URL). */
  lookupKey: string;
  profile: HarvestProfile | null;
  /** universalName of the current employer, used to join the company cache. */
  companyKey: string | null;
  posts: NormalizedPost[];
  comments: NormalizedComment[];
  activity: ActivityStats;
  errors: string[];
  harvestCalls: number;
}

export interface NormalizedPost {
  url: string;
  postedAtIso: string | null;
  postedAtMs: number | null;
  isRepost: boolean;
  text: string;
  likes: number;
  comments: number;
  shares: number;
  totalEngagement: number;
}

export interface NormalizedComment {
  url: string;
  postedAtIso: string | null;
  postedAtMs: number | null;
  text: string;
}

export interface ActivityStats {
  windowMonths: number;
  postCount: number;
  originalPostCount: number;
  repostCount: number;
  commentCount: number;
  reactionCount: number;
  totalEngagement: number;
  avgEngagementPerPost: number;
  lastActivityIso: string | null;
  postsPerMonth: number;
  /** true when the person published or commented at all inside the window. */
  isActive: boolean;
}

/** LLM verdict for one contact. */
export interface Score {
  fit_score: number;
  tier: 'A' | 'B' | 'C' | 'D';
  verdict: 'strong_fit' | 'fit' | 'weak_fit' | 'not_fit';
  seniority: string;
  buying_role: string;
  rationale: string;
  positive_signals: string[];
  risks: string[];
  activity_themes: string[];
  personalized_hook: string;
  recommended_channel: string;
  confidence: 'high' | 'medium' | 'low';
}

/** One fully processed contact — the unit written to the workbook. */
export interface ScoredContact {
  enriched: EnrichedContact;
  company: HarvestCompany | null;
  score: Score | null;
  scoreError: string | null;
}

