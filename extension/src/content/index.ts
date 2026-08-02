import { ScrapedProfile, Message } from '../types';
import { appendScrapedProfiles } from '../utils/storage';
import { getGaussianDelayMs } from '../utils/timing';
import { simulateHumanClick } from '../utils/interaction';

// State
let isScrapingActive = false;

// Selector health tracking per page
let tier3FallbackCount = 0;

function log(message: string) {
  if (import.meta.env.DEV) console.log(message);
  chrome.runtime.sendMessage({
    action: 'LOG_MESSAGE',
    data: message
  }).catch(() => {
    // Popup might be closed
  });
}

/**
 * Per-profile / high-volume logging — DEV builds only. Every runtime.sendMessage
 * wakes the background service worker, so emitting one per profile (25+ per page)
 * keeps the SW churning for no production value.
 */
function debugLog(message: string) {
  if (import.meta.env.DEV) log(message);
}

function errorLog(message: string, error?: any) {
  if (import.meta.env.DEV) console.error(message, error);
  chrome.runtime.sendMessage({
    action: 'LOG_MESSAGE',
    data: `ERROR: ${message} ${error?.message || ''}`
  }).catch(() => { });
}

/**
 * Validate that extracted profile data doesn't contain selector/class artifacts.
 * Returns null if the profile looks like a bad extraction.
 */
function validateProfile(profile: ScrapedProfile): ScrapedProfile | null {
  // Name matches HTML/class patterns — selector leaked into text
  if (/^[.\[#]|artdeco|ember|^data-/i.test(profile.name)) {
    return null;
  }
  // profileUrl must be a Sales Navigator link
  if (!profile.profileUrl.includes('/sales/lead/') && !profile.profileUrl.includes('/sales/people/')) {
    return null;
  }
  // title === name usually means a selector hit the wrong element
  if (profile.title && profile.title === profile.name) {
    return null;
  }
  return profile;
}

/**
 * Extract profile data from a list item element.
 * Uses three selector tiers: data-anonymize (T1), artdeco classes (T2), structural/positional (T3).
 */
function extractProfileData(listItem: Element): { profile: ScrapedProfile | null; usedTier3: boolean } {
  try {
    // --- Tier 1: data-anonymize selectors ---
    const nameElement = listItem.querySelector('[data-anonymize="person-name"]');
    const titleElement = listItem.querySelector('[data-anonymize="title"]');
    const companyElement = listItem.querySelector('[data-anonymize="company-name"]');
    const locationElement = listItem.querySelector('[data-anonymize="location"]');
    const linkElement = listItem.querySelector('a[href*="/sales/lead/"]');

    // --- Tier 2: artdeco class selectors ---
    let name = nameElement?.textContent?.trim() ||
      listItem.querySelector('.artdeco-entity-lockup__title')?.textContent?.trim() ||
      listItem.querySelector('.artdeco-entity-lockup__title a')?.textContent?.trim() ||
      listItem.querySelector('a[data-control-name="view_lead_panel_via_search_lead_name"]')?.textContent?.trim() || '';

    let title = titleElement?.textContent?.trim() ||
      listItem.querySelector('.artdeco-entity-lockup__subtitle')?.textContent?.trim() || '';

    let company = companyElement?.textContent?.trim() ||
      listItem.querySelector('.artdeco-entity-lockup__caption')?.textContent?.trim() || '';

    const location = locationElement?.textContent?.trim() || '';
    const profileUrl = linkElement?.getAttribute('href') || '';

    let usedTier3 = false;

    // --- Tier 3: structural/positional selectors (fallback) ---
    if (!name) {
      const leadLink = listItem.querySelector('a[href*="/sales/lead/"]');
      const tier3Name = leadLink?.textContent?.trim() || '';
      if (tier3Name) {
        name = tier3Name;
        usedTier3 = true;
      }
    }

    if (!name) {
      // Debug logging only in dev builds
      if (import.meta.env.DEV) {
        log(`[CONTENT] DEBUG: Failed to find name. Classes: ${listItem.className}`);
        log(`[CONTENT] DEBUG: data-anonymize elements: ${listItem.querySelectorAll('[data-anonymize]').length}`);
        log(`[CONTENT] DEBUG: lockup title elements: ${listItem.querySelectorAll('.artdeco-entity-lockup__title').length}`);

        const anchors = listItem.querySelectorAll('a');
        log(`[CONTENT] DEBUG: Found ${anchors.length} anchor tags`);
        anchors.forEach((a, idx) => {
          log(`[CONTENT] DEBUG: Anchor ${idx}: href="${a.getAttribute('href')?.substring(0, 50)}", text="${a.textContent?.trim().substring(0, 50)}"`);
        });

        const html = listItem.innerHTML.substring(0, 500);
        log(`[CONTENT] DEBUG: Item HTML: ${html}...`);
      }

      return { profile: null, usedTier3 };
    }

    const rawProfile: ScrapedProfile = {
      name,
      title,
      company,
      location,
      profileUrl: profileUrl.startsWith('http') ? profileUrl : `https://www.linkedin.com${profileUrl}`,
      scrapedAt: new Date().toISOString(),
    };

    // Validate extraction quality
    const validated = validateProfile(rawProfile);
    return { profile: validated, usedTier3 };
  } catch (error) {
    errorLog('[CONTENT] Error extracting profile data:', error);
    return { profile: null, usedTier3: false };
  }
}

/**
 * Scroll all lazy-loaded items into view to trigger loading.
 * Uses humanized timing with occasional batch scrolls and reading pauses.
 */
async function scrollItemsIntoView(items: NodeListOf<Element>): Promise<void> {
  log('[CONTENT] Scrolling items into view to trigger lazy loading...');

  let i = 0;
  while (i < items.length) {
    const rand = Math.random();

    // 30% chance: batch 3-5 items with a short delay each (~50ms)
    if (rand < 0.3 && i + 2 < items.length) {
      const batchSize = 3 + Math.floor(Math.random() * 3); // 3-5
      const end = Math.min(i + batchSize, items.length);
      for (let j = i; j < end; j++) {
        items[j].scrollIntoView({ behavior: 'smooth', block: 'center' });
        await new Promise(resolve => setTimeout(resolve, getGaussianDelayMs(30, 70)));
      }
      i = end;
    } else {
      // Normal scroll: one item at a time with Gaussian delay
      items[i].scrollIntoView({ behavior: 'smooth', block: 'center' });
      await new Promise(resolve => setTimeout(resolve, getGaussianDelayMs(50, 200)));
      i++;
    }

    // 15% chance: add an extra "reading pause" after scrolling
    if (Math.random() < 0.15) {
      await new Promise(resolve => setTimeout(resolve, getGaussianDelayMs(300, 600)));
    }
  }

  log('[CONTENT] Scrolled all items into view');

  // Wait additional time for all content to finish loading (humanized)
  const postScrollWait = getGaussianDelayMs(1500, 3500);
  log(`[CONTENT] Waiting ${Math.round(postScrollWait / 1000)}s for all content to load...`);
  await new Promise(resolve => setTimeout(resolve, postScrollWait));
}

/**
 * Scrape all profiles on the current page
 */
async function scrapeCurrentPage(): Promise<ScrapedProfile[]> {
  log('[CONTENT] Scraping current page...');
  log(`[CONTENT] Current URL: ${window.location.href}`);
  log(`[CONTENT] Page title: ${document.title}`);

  const profiles: ScrapedProfile[] = [];

  // Wait for content to load
  log('[CONTENT] Waiting for profile items to load...');
  const loaded = await waitForElements('.artdeco-entity-lockup__title, [data-anonymize="person-name"]', 10000);

  if (!loaded) {
    log('[CONTENT] WARNING: Content may not be fully loaded, attempting to scrape anyway');
  }

  // Find all list items - try multiple selectors
  const selectors = [
    '.artdeco-list__item',
    'li[data-anonymize="person"]',
    'li.artdeco-list__item',
    '.scaffold-layout__list-item',
  ];

  let listItems: NodeListOf<Element> | null = null;

  for (const selector of selectors) {
    listItems = document.querySelectorAll(selector);
    if (listItems.length > 0) {
      log(`[CONTENT] Found ${listItems.length} items using selector: ${selector}`);
      break;
    } else {
      log(`[CONTENT] No items found using selector: ${selector}`);
    }
  }

  if (!listItems || listItems.length === 0) {
    log(`[CONTENT] ERROR: No profile list items found on page`);
    log(`[CONTENT] Body classes: ${document.body.className.substring(0, 200)}`);
    log(`[CONTENT] Body has ${document.body.children.length} child elements`);
    const childInfo = Array.from(document.body.children).slice(0, 5).map(el =>
      `${el.tagName}${el.id ? '#' + el.id : ''}${el.className ? '.' + el.className.split(' ')[0] : ''}`
    ).join(', ');
    log(`[CONTENT] First children: ${childInfo}`);
    return profiles;
  }

  // Scroll all items into view to trigger lazy loading
  await scrollItemsIntoView(listItems);

  // Track tier 3 fallback usage for this page
  let pageTier3Count = 0;

  log(`[CONTENT] Starting profile extraction from ${listItems.length} items`);
  listItems.forEach((item, index) => {
    // Skip items that are hidden (aria-hidden="true")
    const article = item.querySelector('article[aria-hidden="true"]');
    if (article) {
      debugLog(`[CONTENT] Skipping item ${index + 1} (aria-hidden="true" - LinkedIn is hiding this profile)`);
      return;
    }

    const { profile, usedTier3 } = extractProfileData(item);
    if (usedTier3) pageTier3Count++;

    if (profile) {
      profiles.push(profile);
      debugLog(`[CONTENT] Extracted profile ${index + 1}: ${profile.name}`);
    } else {
      debugLog(`[CONTENT] Failed to extract profile from item ${index + 1}`);
    }
  });

  // If tier 1+2 failed but tier 3 succeeded, notify background for health monitoring
  if (pageTier3Count > 0) {
    tier3FallbackCount++;
    log(`[CONTENT] Selector degradation: ${pageTier3Count} profiles used tier 3 fallback (consecutive pages: ${tier3FallbackCount})`);
    chrome.runtime.sendMessage({
      action: 'SELECTOR_DEGRADED',
      data: { tier3Count: pageTier3Count, consecutivePages: tier3FallbackCount },
    }).catch(() => {});
  } else {
    tier3FallbackCount = 0; // Reset consecutive count
  }

  log(`[CONTENT] Extraction complete: ${profiles.length}/${listItems.length} profiles successfully scraped`);
  return profiles;
}

/**
 * Cheap fingerprint of the currently-rendered lead list: URL (the page param
 * changes on SPA pagination) + the first few lead-link hrefs (always change
 * between pages even if the URL pattern doesn't).
 */
function getPageFingerprint(): string {
  const leadHrefs = Array.from(document.querySelectorAll('a[href*="/sales/lead/"]'))
    .slice(0, 3)
    .map((a) => a.getAttribute('href') || '')
    .join('|');
  return `${window.location.href}::${leadHrefs}`;
}

/**
 * Poll the page fingerprint until it changes (i.e. the next page actually
 * rendered) instead of trusting a fixed sleep — slow loads otherwise let the
 * scraper re-scrape the old page. Returns false on timeout.
 */
async function waitForPageChange(beforeFingerprint: string, timeoutMs: number = 15000): Promise<boolean> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 500));
    if (getPageFingerprint() !== beforeFingerprint) {
      log(`[CONTENT] Page changed after ${Date.now() - startTime}ms`);
      // Give the new page a moment to settle before scraping starts.
      await new Promise(resolve => setTimeout(resolve, getGaussianDelayMs(800, 1800)));
      return true;
    }
  }
  return false;
}

/**
 * Click a Next button and verify navigation actually happened.
 * Returns true only if the page fingerprint changed within the timeout.
 */
async function clickAndVerifyNavigation(button: HTMLButtonElement): Promise<boolean> {
  const before = getPageFingerprint();
  await simulateHumanClick(button);

  log('[CONTENT] Waiting for page to change after Next click...');
  const changed = await waitForPageChange(before);
  if (!changed) {
    log('[CONTENT] WARNING: Page did not change within 15s after Next click — treating as last page');
    return false;
  }
  return true;
}

/**
 * Find and click the "Next" button using simulateHumanClick
 */
async function clickNextButton(): Promise<boolean> {
  log('[CONTENT] Searching for Next button...');

  // Try multiple selectors for the next button
  const selectors = [
    'button[aria-label="Next"]',
    'button[aria-label="View next page"]',
    '.artdeco-pagination__button--next',
    'button.artdeco-button[aria-label*="next" i]',
  ];

  for (const selector of selectors) {
    const nextButton = document.querySelector(selector) as HTMLButtonElement;
    if (nextButton && !nextButton.disabled) {
      log(`[CONTENT] Clicking next button found with selector: ${selector}`);
      return clickAndVerifyNavigation(nextButton);
    } else if (nextButton) {
      log(`[CONTENT] Next button found but disabled: ${selector}`);
    }
  }

  // Fallback: try to find button by text content
  log('[CONTENT] Trying fallback: find button containing "Next" text...');
  const allButtons = document.querySelectorAll('button');
  for (const button of allButtons) {
    const text = button.textContent?.trim();
    if (text === 'Next' && !button.disabled) {
      log(`[CONTENT] Found Next button by text content`);
      return clickAndVerifyNavigation(button);
    }
  }

  log('[CONTENT] Next button not found or disabled');
  return false;
}

/**
 * Wait for elements to load on the page
 */
async function waitForElements(selector: string, timeout: number = 10000): Promise<boolean> {
  log(`[CONTENT] Waiting for elements matching: ${selector}`);
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const elements = document.querySelectorAll(selector);
    if (elements.length > 0) {
      // Check if at least some elements have content
      const hasContent = Array.from(elements).some(el => {
        const text = el.textContent?.trim() || '';
        return text.length > 0;
      });

      if (hasContent) {
        log(`[CONTENT] Found ${elements.length} loaded elements after ${Date.now() - startTime}ms`);
        return true;
      }
    }

    // Wait 500ms before checking again
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  log(`[CONTENT] Timeout waiting for elements after ${timeout}ms`);
  return false;
}

/**
 * Perform the scraping operation.
 *
 * Scraped rows are only persisted to chrome.storage here — nothing is sent
 * anywhere. The background worker packages the whole run and submits it to the
 * enrichment worker once, at end of run.
 *
 * NOTE: Inter-page delay is handled by the background worker, NOT here.
 */
async function performScrape(page: number) {
  log(`[CONTENT] ========== Starting scrape for page ${page} ==========`);
  log(`[CONTENT] isScrapingActive: ${isScrapingActive}`);

  if (!isScrapingActive) {
    log('[CONTENT] WARNING: Scraping stopped by user, aborting');
    return;
  }

  try {
    // Scrape current page
    log('[CONTENT] Starting DOM scraping...');
    const profiles = await scrapeCurrentPage();
    log(`[CONTENT] DOM scraping complete: ${profiles.length} profiles found`);

    if (profiles.length === 0) {
      log('[CONTENT] WARNING: No profiles found on this page');
    } else {
      log(`[CONTENT] Saving ${profiles.length} profiles to storage...`);
      await appendScrapedProfiles(profiles);
      log('[CONTENT] Profiles saved to storage');
    }

    // Check for next page
    log('[CONTENT] Checking for next page button...');
    const hasNextPage = await clickNextButton();
    log(`[CONTENT] Next page available: ${hasNextPage}`);

    // Notify background script of per-page completion — background handles delay
    // before the next page. This is PAGE_COMPLETE, not SCRAPING_COMPLETE: the
    // popup also receives this broadcast directly and must not treat a page
    // boundary as end-of-run.
    log('[CONTENT] Sending PAGE_COMPLETE to background...');
    chrome.runtime.sendMessage({
      action: 'PAGE_COMPLETE',
      data: {
        scrapedCount: profiles.length,
        hasNextPage,
      },
    }).catch((err) => {
      if (import.meta.env.DEV) console.error('[CONTENT] Failed to send PAGE_COMPLETE:', err);
    });
    log('[CONTENT] PAGE_COMPLETE sent to background');

    log(`[CONTENT] ========== Page ${page} complete ==========`);
  } catch (error) {
    errorLog('[CONTENT] ERROR during scraping:', error);

    isScrapingActive = false;

    // Send error to background
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    const errorStack = error instanceof Error ? error.stack : undefined;

    log(`[CONTENT] Sending SCRAPING_ERROR to background: ${errorMessage}`);
    chrome.runtime.sendMessage({
      action: 'SCRAPING_ERROR',
      data: {
        message: errorMessage,
        details: errorStack,
      },
    }).catch((err) => {
      if (import.meta.env.DEV) console.error('[CONTENT] Failed to send SCRAPING_ERROR:', err);
    });
  }
}

/**
 * Message listener
 */
chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
  // PING is a noisy no-op probe; respond and return without logging.
  if (message.action === 'PING') {
    sendResponse({ pong: true });
    return;
  }

  log(`[CONTENT] <<<< Received message: ${message.action} ${message.data ? JSON.stringify(message.data) : ''}`);

  switch (message.action) {
    case 'SCRAPE_PAGE':
      log(`[CONTENT] Processing SCRAPE_PAGE - isScrapingActive: ${isScrapingActive}`);
      if (!isScrapingActive) {
        log('[CONTENT] ERROR: Scraping not active, ignoring SCRAPE_PAGE');
        sendResponse({ success: false, message: 'Scraping not active' });
        return;
      }

      const page = message.data?.page || 1;
      log(`[CONTENT] Starting scrape for page ${page}`);
      performScrape(page);
      sendResponse({ success: true });
      break;

    case 'START_SCRAPING':
      isScrapingActive = true;
      tier3FallbackCount = 0; // Reset selector health on new session
      log('[CONTENT] Scraping flag set to TRUE');
      sendResponse({ success: true });
      break;

    case 'STOP_SCRAPING':
      isScrapingActive = false;
      log('[CONTENT] Scraping flag set to FALSE');
      sendResponse({ success: true });
      break;

    default:
      log(`[CONTENT] WARNING: Unknown message action: ${message.action}`);
      sendResponse({ error: 'Unknown action' });
  }
});

log('[CONTENT] ===== SalesNav Enrichment content script LOADED =====');
log(`[CONTENT] Script loaded on: ${window.location.href}`);
