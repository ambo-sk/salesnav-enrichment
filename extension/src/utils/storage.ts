import { Settings, ScrapingState, PushSession, ScrapedProfile, ScrapedCompany } from '../types';
import type { RunState } from '../enrichment/runner';

// Default settings
const DEFAULT_SETTINGS: Settings = {
  workerUrl: '',
  label: '',
  icp: '',
  minDelay: 8,
  maxDelay: 25,
  pagesPerSession: 25,
  cooldownMinutes: 7,
  dailyLimit: 800,
  workingHoursStart: 8,
  workingHoursEnd: 18,
  autoResumeAfterCooldown: true,
  autoEnrichOnComplete: true,
};

// Storage keys
const SETTINGS_KEY = 'settings';            // chrome.storage.sync — non-secret prefs only
const SECRETS_KEY = 'secrets';              // chrome.storage.local — apiToken
const STATE_KEY = 'scrapingState';
const PUSH_SESSION_KEY = 'currentPushSession';
const RUN_KEY = 'enrichmentRun';              // chrome.storage.local — the whole run
const SCRAPED_KEY = 'scrapedProfiles';
const SCRAPED_COMPANIES_KEY = 'scrapedCompanies';
const COMPANY_SEARCH_URLS_KEY = 'companySearchUrls';

// Initial/empty scraping state — single source of truth for the shape.
export const INITIAL_SCRAPING_STATE: ScrapingState = {
  isActive: false,
  mode: 'contacts',
  currentPage: 0,
  totalScraped: 0,
  sessionPageCount: 0,
  cooldownUntil: null,
  targetPageCount: null,
  resumeTabId: null,
  scrapingTabId: null,
  lastCompletedPage: 0,
  nextScrapeAt: null,
  lastProgressAt: null,
};

/**
 * Get settings. Non-secret prefs live in chrome.storage.sync; the bearer token
 * lives in chrome.storage.local so it does NOT replicate to every device signed
 * into the Chrome profile.
 */
export async function getSettings(): Promise<Settings> {
  try {
    const [syncResult, localResult] = await Promise.all([
      chrome.storage.sync.get(SETTINGS_KEY),
      chrome.storage.local.get(SECRETS_KEY),
    ]);
    const syncSettings: Partial<Settings> = { ...(syncResult[SETTINGS_KEY] || {}) };
    const secrets: { apiToken?: string } = localResult[SECRETS_KEY] || {};

    // A token that ever landed in sync storage is a token replicated to every
    // signed-in device. Move it out and strip it, re-reading the sync blob right
    // before the write so a concurrent saveSettings is not clobbered.
    if (syncSettings.apiToken) {
      const migrated = { apiToken: syncSettings.apiToken ?? secrets.apiToken };
      await chrome.storage.local.set({ [SECRETS_KEY]: migrated });
      const freshSync = await chrome.storage.sync.get(SETTINGS_KEY);
      const freshPrefs: Partial<Settings> = { ...(freshSync[SETTINGS_KEY] || {}) };
      delete freshPrefs.apiToken;
      await chrome.storage.sync.set({ [SETTINGS_KEY]: freshPrefs });
      delete syncSettings.apiToken;
      console.log('Migrated API token from sync to local storage');
      return { ...DEFAULT_SETTINGS, ...syncSettings, ...migrated };
    }

    return { ...DEFAULT_SETTINGS, ...syncSettings, ...secrets };
  } catch (error) {
    console.error('Error getting settings:', error);
    return DEFAULT_SETTINGS;
  }
}

/**
 * Save settings — the token to chrome.storage.local, everything else to sync.
 */
export async function saveSettings(settings: Settings): Promise<void> {
  try {
    const { apiToken, ...prefs } = settings;
    await Promise.all([
      chrome.storage.local.set({ [SECRETS_KEY]: { apiToken } }),
      chrome.storage.sync.set({ [SETTINGS_KEY]: prefs }),
    ]);
  } catch (error) {
    console.error('Error saving settings:', error);
    throw error;
  }
}

/**
 * Get scraping state from chrome.storage.local
 */
export async function getScrapingState(): Promise<ScrapingState> {
  try {
    const result = await chrome.storage.local.get(STATE_KEY);
    // Spread over INITIAL so states persisted by older versions get new fields.
    return { ...INITIAL_SCRAPING_STATE, ...(result[STATE_KEY] || {}) };
  } catch (error) {
    console.error('Error getting scraping state:', error);
    return { ...INITIAL_SCRAPING_STATE };
  }
}

/**
 * Save scraping state to chrome.storage.local
 */
export async function saveScrapingState(state: ScrapingState): Promise<void> {
  try {
    await chrome.storage.local.set({ [STATE_KEY]: state });
  } catch (error) {
    console.error('Error saving scraping state:', error);
    throw error;
  }
}

/**
 * Reset scraping state to initial values
 */
export async function resetScrapingState(): Promise<void> {
  await saveScrapingState({ ...INITIAL_SCRAPING_STATE });
}

// ─── Scraped profiles (the in-progress run) ───

export async function getScrapedProfiles(): Promise<ScrapedProfile[]> {
  try {
    const result = await chrome.storage.local.get(SCRAPED_KEY);
    return result[SCRAPED_KEY] || [];
  } catch (error) {
    console.error('Error getting scraped profiles:', error);
    return [];
  }
}

export async function saveScrapedProfiles(profiles: ScrapedProfile[]): Promise<void> {
  try {
    await chrome.storage.local.set({ [SCRAPED_KEY]: profiles });
  } catch (error) {
    console.error('Error saving scraped profiles:', error);
  }
}

export async function appendScrapedProfiles(newProfiles: ScrapedProfile[]): Promise<void> {
  try {
    const existing = await getScrapedProfiles();
    await saveScrapedProfiles([...existing, ...newProfiles]);
  } catch (error) {
    console.error('Error appending scraped profiles:', error);
  }
}

export async function clearScrapedProfiles(): Promise<void> {
  try {
    await chrome.storage.local.remove(SCRAPED_KEY);
  } catch (error) {
    console.error('Error clearing scraped profiles:', error);
  }
}

// ─── Scraped companies (company-list runs — no enrichment, export only) ───

export async function getScrapedCompanies(): Promise<ScrapedCompany[]> {
  try {
    const result = await chrome.storage.local.get(SCRAPED_COMPANIES_KEY);
    return result[SCRAPED_COMPANIES_KEY] || [];
  } catch (error) {
    console.error('Error getting scraped companies:', error);
    return [];
  }
}

export async function appendScrapedCompanies(newCompanies: ScrapedCompany[]): Promise<void> {
  try {
    const existing = await getScrapedCompanies();
    await chrome.storage.local.set({ [SCRAPED_COMPANIES_KEY]: [...existing, ...newCompanies] });
  } catch (error) {
    console.error('Error appending scraped companies:', error);
  }
}

export async function clearScrapedCompanies(): Promise<void> {
  try {
    // Search URLs are derived from the company rows — they go together.
    await chrome.storage.local.remove([SCRAPED_COMPANIES_KEY, COMPANY_SEARCH_URLS_KEY]);
  } catch (error) {
    console.error('Error clearing scraped companies:', error);
  }
}

// Built Sales Nav people-search URLs for the scraped companies. Persisted
// because clicking a link closes the popup — component state would be lost.
export interface CompanySearchUrls {
  urls: { url: string; companies: string[] }[];
  unresolved: string[];
  builtAt: string;
}

export async function getCompanySearchUrls(): Promise<CompanySearchUrls | null> {
  try {
    const result = await chrome.storage.local.get(COMPANY_SEARCH_URLS_KEY);
    return result[COMPANY_SEARCH_URLS_KEY] || null;
  } catch (error) {
    console.error('Error getting company search URLs:', error);
    return null;
  }
}

export async function saveCompanySearchUrls(value: CompanySearchUrls): Promise<void> {
  try {
    await chrome.storage.local.set({ [COMPANY_SEARCH_URLS_KEY]: value });
  } catch (error) {
    console.error('Error saving company search URLs:', error);
  }
}

// ─── Enrichment run ───
//
// The full run state is megabytes for a 1000-contact list (enriched profiles,
// posts, comments, scores), which is why the manifest requests
// `unlimitedStorage`. It is written at every chunk boundary so a killed
// service worker resumes instead of re-paying for work already done.

export async function getRunState(): Promise<RunState | null> {
  try {
    const result = await chrome.storage.local.get(RUN_KEY);
    return result[RUN_KEY] || null;
  } catch (error) {
    console.error('Error getting run state:', error);
    return null;
  }
}

export async function saveRunState(state: RunState): Promise<void> {
  await chrome.storage.local.set({ [RUN_KEY]: state });
}

export async function clearRunState(): Promise<void> {
  try {
    await chrome.storage.local.remove(RUN_KEY);
  } catch (error) {
    console.error('Error clearing run state:', error);
  }
}

// ─── Push session ───

export async function getPushSession(): Promise<PushSession | null> {
  try {
    const result = await chrome.storage.local.get(PUSH_SESSION_KEY);
    return result[PUSH_SESSION_KEY] || null;
  } catch (error) {
    console.error('Error getting push session:', error);
    return null;
  }
}

export async function savePushSession(session: PushSession): Promise<void> {
  try {
    await chrome.storage.local.set({ [PUSH_SESSION_KEY]: session });
  } catch (error) {
    console.error('Error saving push session:', error);
  }
}

export async function clearPushSession(): Promise<void> {
  try {
    await chrome.storage.local.remove(PUSH_SESSION_KEY);
  } catch (error) {
    console.error('Error clearing push session:', error);
  }
}
