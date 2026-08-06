/**
 * Types for the client-side enrichment pipeline.
 *
 * The HarvestAPI shapes below are deliberately partial: only the fields this
 * pipeline actually reads are typed. Everything else is carried through as
 * `unknown` rather than being mirrored, so a HarvestAPI field addition can
 * never break a build here.
 */

import type { ContactInfo } from './contacts';



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
  status?: string;
  error?: string;
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

// ─── Normalized pipeline shapes ───

/** Everything gathered for one person, before scoring. */
export interface EnrichedContact {
  input: InboundContact;
  /** HarvestAPI lookup key actually used (sales-nav id or profile URL). */
  lookupKey: string;
  profile: HarvestProfile | null;
  /** universalName of the current employer, used to join the company cache. */
  companyKey: string | null;
  errors: string[];
  harvestCalls: number;
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
  /** Similarweb emails and phones. Null when not looked up or not found. */
  contact: ContactInfo | null;
}

