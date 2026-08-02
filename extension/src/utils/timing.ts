/**
 * Human-like timing utilities using truncated Gaussian distribution.
 * Replaces uniform Math.random() which produces flat, machine-detectable patterns.
 */

/**
 * Box-Muller transform: generates a standard normal random variable (mean=0, stddev=1).
 */
function boxMullerRandom(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random(); // avoid log(0)
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/**
 * Truncated Gaussian random number between min and max.
 * Mean at 60% of range, stddev at 25% of range — humans cluster around a natural mean
 * with occasional fast/slow outliers, unlike uniform distribution.
 */
export function gaussianRandom(min: number, max: number): number {
  const range = max - min;
  const mean = min + range * 0.6;
  const stddev = range * 0.25;

  // Generate and clamp to [min, max]
  let value: number;
  do {
    value = mean + boxMullerRandom() * stddev;
  } while (value < min || value > max);

  return value;
}

/**
 * Gaussian-distributed delay in milliseconds.
 */
export function getGaussianDelayMs(minMs: number, maxMs: number): number {
  return Math.round(gaussianRandom(minMs, maxMs));
}

/**
 * Add jitter to a base delay (useful for API dispatch timing).
 * Returns base + random(0, jitterMs) with Gaussian distribution.
 */
export function addJitter(baseMs: number, jitterMs: number): number {
  return baseMs + Math.round(gaussianRandom(0, jitterMs));
}
