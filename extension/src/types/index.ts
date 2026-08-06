// Message actions between components
export type MessageAction =
  | 'START_SCRAPING'
  | 'STOP_SCRAPING'
  | 'SCRAPE_PAGE'
  | 'SCRAPING_STATUS'
  // Per-page completion: content -> background after each page is scraped.
  | 'PAGE_COMPLETE'
  // End-of-run completion: background -> popup, sent exactly once per run.
  | 'SCRAPING_COMPLETE'
  | 'SCRAPING_ERROR'
  | 'LOG_MESSAGE'
  | 'SELECTOR_DEGRADED'
  // No-op probe from background to check whether the content script is loaded.
  | 'PING'
  // ─── Enrichment run ───
  // popup -> background: current run state summary
  | 'GET_RUN'
  // background -> popup: the run advanced
  | 'RUN_UPDATED'
  // popup -> background: start / stop / discard an enrichment run
  | 'START_ENRICHMENT'
  | 'STOP_ENRICHMENT'
  | 'DISCARD_RUN'
  // popup -> background: score a finished run again, reusing its enrichment
  | 'RESCORE_RUN'
  // background -> popup: enrichment failed
  | 'ENRICHMENT_ERROR';

// Scraped profile data structure
export interface ScrapedProfile {
  name: string;
  title: string;
  company: string;
  location: string;
  profileUrl: string;
  scrapedAt: string;
}

// Extension settings stored in chrome.storage
export interface Settings {
  // Base URL of the Cloudflare enrichment worker, e.g.
  // https://salesnav-enrichment.<subdomain>.workers.dev
  workerUrl: string;
  // Run label — names the resulting workbook.
  label: string;
  // Ideal customer profile the worker scores against. Empty = the worker's
  // configured default.
  icp: string;
  minDelay: number;    // seconds (default: 8)
  maxDelay: number;    // seconds (default: 25)
  // Bearer token issued by the worker operator (snv_ prefix).
  // Stored in chrome.storage.local so it never syncs across devices.
  apiToken?: string;
  // Safety limits
  pagesPerSession: number;    // default: 25
  cooldownMinutes: number;    // default: 7
  dailyLimit: number;         // default: 800
  workingHoursStart: number;  // default: 8
  workingHoursEnd: number;    // default: 18
  autoResumeAfterCooldown: boolean; // default: true
  // Start enrichment automatically when a scraping run ends.
  autoEnrichOnComplete: boolean;    // default: true
}

// Current scraping state.
// EVERYTHING needed to continue a run lives here (persisted to chrome.storage.local),
// never in service-worker module variables — the MV3 SW dies after ~30s idle and
// module state is lost.
export interface ScrapingState {
  isActive: boolean;
  currentPage: number;
  totalScraped: number;
  sessionPageCount: number;
  cooldownUntil: number | null;
  // null = scrape until safety limits / no next page; positive int = stop after this many completed pages
  targetPageCount: number | null;
  // Persisted so the auto-resume alarm can find the tab after the SW restarts
  resumeTabId: number | null;
  // The tab currently being scraped (persisted — survives SW restarts mid-run)
  scrapingTabId: number | null;
  // Highest page number completed this run (dedup guard + pagesScraped metric)
  lastCompletedPage: number;
  // Epoch ms when the next SCRAPE_PAGE should fire (null = none pending).
  // Backed by the 'next-page' chrome.alarm so inter-page delays survive SW death.
  nextScrapeAt: number | null;
  // Epoch ms of the last PAGE_COMPLETE (or run start/resume). The watchdog alarm
  // halts the run if this goes stale (>5min) with no delay/cooldown pending.
  lastProgressAt: number | null;
}

// Message structure for communication between components
export interface Message<T = any> {
  action: MessageAction;
  data?: T;
}

// ─── Enrichment worker wire format ───

/** One scraped contact, as the enrichment pipeline consumes it. */
export interface WorkerContact {
  linkedin_url: string;
  name?: string;
  title?: string;
  company?: string;
  location?: string;
}

/** Everything the popup needs to render the enrichment run. Kept small — the
 *  full run state is megabytes and stays in chrome.storage. */
export interface RunSummary {
  active: boolean;
  phase: 'enriching' | 'companies' | 'contacts' | 'scoring' | 'complete' | 'error' | 'stopped';
  phaseLabel: string;
  done: number;
  total: number;
  contactCount: number;
  scoredCount: number;
  label: string;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  harvestCalls: number;
  llmCalls: number;
  /** True once there are rows worth exporting, even if the run ended early. */
  downloadable: boolean;
}

// Status types for UI
export type ScraperStatus = 'idle' | 'scraping' | 'error' | 'complete';

// Error message structure
export interface ErrorMessage {
  message: string;
  details?: string;
}

// One scraping session — one click of Start through to its end. Persisted to
// chrome.storage.local so it survives SW restarts during cooldown.
export interface PushSession {
  startedAt: string;
  endedAt: string | null;
  endReason:
    | 'completed'
    | 'stopped'
    | 'error'
    | 'daily_limit'
    | 'cooldown_no_resume'
    | 'tab_lost'
    | 'interrupted'
    | null;
  label: string;
  // The Sales Navigator URL at session start — encodes the search criteria
  salesNavUrl: string;
  tabTitle: string;
  totals: {
    pagesScraped: number;
    profilesScraped: number;
  };
}
