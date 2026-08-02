const DAILY_COUNTS_KEY = 'dailyCounts';

/**
 * YYYY-MM-DD in LOCAL time. Working hours are local, so the daily counter must
 * roll over at local midnight too (toISOString would key it by UTC date).
 */
function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function todayKey(): string {
  return dateKey(new Date());
}

/**
 * Get today's scraped profile count.
 */
export async function getDailyCount(): Promise<number> {
  try {
    const result = await chrome.storage.local.get(DAILY_COUNTS_KEY);
    const counts: Record<string, number> = result[DAILY_COUNTS_KEY] || {};
    return counts[todayKey()] || 0;
  } catch {
    return 0;
  }
}

/**
 * Add to today's count. Returns the new total.
 * Also prunes entries older than 7 days.
 */
export async function incrementDailyCount(count: number): Promise<number> {
  try {
    const result = await chrome.storage.local.get(DAILY_COUNTS_KEY);
    const counts: Record<string, number> = result[DAILY_COUNTS_KEY] || {};
    const key = todayKey();
    counts[key] = (counts[key] || 0) + count;

    // Prune old entries (keep last 7 days)
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    const cutoffStr = dateKey(cutoff);
    for (const k of Object.keys(counts)) {
      if (k < cutoffStr) delete counts[k];
    }

    await chrome.storage.local.set({ [DAILY_COUNTS_KEY]: counts });
    return counts[key];
  } catch {
    return 0;
  }
}

/**
 * Check if the daily limit has been reached.
 */
export async function isDailyLimitReached(limit: number): Promise<boolean> {
  const count = await getDailyCount();
  return count >= limit;
}

/**
 * Check if the current hour is within the configured working hours.
 * Supports overnight (wrap-around) windows: start=22, end=6 means 22:00-05:59.
 * start === end is nonsensical (Options blocks saving it); fail open so a
 * legacy bad config can't defer auto-resume forever.
 */
export function isWithinWorkingHours(start: number, end: number): boolean {
  const hour = new Date().getHours();
  if (start === end) return true;
  if (start < end) return hour >= start && hour < end;
  // Overnight window (e.g. 22 -> 6): inside = late evening OR early morning.
  return hour >= start || hour < end;
}

/**
 * Get milliseconds remaining in cooldown. Returns 0 if expired or null.
 */
export function getCooldownRemaining(cooldownUntil: number | null): number {
  if (!cooldownUntil) return 0;
  return Math.max(0, cooldownUntil - Date.now());
}

/**
 * Epoch ms of the next time the local clock hits `startHour`:00
 * (today if still ahead, otherwise tomorrow).
 *
 * Consistent with wrap-around windows too: callers only invoke this while
 * OUTSIDE the window (isWithinWorkingHours returned false), and outside an
 * overnight window (start > end) the current hour is always in [end, start),
 * so "next time the clock hits startHour" is still the window's next opening.
 */
export function nextWorkingHoursStart(startHour: number): number {
  const next = new Date();
  next.setHours(startHour, 0, 0, 0);
  if (next.getTime() <= Date.now()) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime();
}
