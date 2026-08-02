/**
 * Self-check for the proxy worker's remaining logic: the score parser and the
 * ICP. Everything else moved to the extension, which has its own checks.
 *
 *   npm test
 */

import assert from 'node:assert/strict';
import { parseScore } from '../src/openrouter';
import { SOKIN_ICP, icpText } from '../src/icp';

let checks = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    checks++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    throw err;
  }
}

console.log('\nsalesnav enrichment proxy — self-check\n');

check('parseScore accepts raw, fenced and prose-wrapped JSON', () => {
  const body = JSON.stringify({
    fit_score: 84, tier: 'A', verdict: 'strong_fit', seniority: 'VP',
    buying_role: 'economic_buyer', rationale: 'Owns the payments budget.',
    positive_signals: ['posts about FX costs'], risks: [], activity_themes: ['treasury'],
    personalized_hook: 'Saw your post on FX spread.', recommended_channel: 'LinkedIn',
    confidence: 'high',
  });
  for (const variant of [body, '```json\n' + body + '\n```', 'Here you go:\n' + body + '\nHope that helps.']) {
    const score = parseScore(variant);
    assert.ok(score, `failed to parse: ${variant.slice(0, 30)}`);
    assert.equal(score.fit_score, 84);
    assert.equal(score.tier, 'A');
  }
});

check('parseScore reconciles a tier that contradicts the score', () => {
  const score = parseScore('{"fit_score": 30, "tier": "banana", "verdict": "nonsense"}');
  assert.ok(score);
  assert.equal(score.tier, 'D');
  assert.equal(score.verdict, 'not_fit');
  assert.equal(score.confidence, 'medium');
  assert.deepEqual(score.risks, []);
});

check('parseScore clamps out-of-range scores and rejects junk', () => {
  assert.equal(parseScore('{"fit_score": 250}')?.fit_score, 100);
  assert.equal(parseScore('{"fit_score": -10}')?.fit_score, 0);
  assert.equal(parseScore('I refuse to answer.'), null);
  assert.equal(parseScore('{"tier": "A"}'), null);
  assert.equal(parseScore(''), null);
});

check('a long ICP survives intact and the default is complete', () => {
  assert.equal(icpText('x'.repeat(5000)).length, 5000, 'a long ICP was truncated');
  assert.equal(icpText('  padded  '), 'padded');
  assert.equal(icpText(undefined), '');
  assert.equal(icpText(42), '');
  assert.equal(icpText('y'.repeat(50000)).length, 20000);

  for (const section of ['MOTION A', 'MOTION B', 'DISQUALIFY', 'HOW TO WEIGH IT', 'THE HOOK']) {
    assert.ok(SOKIN_ICP.includes(section), `default ICP is missing "${section}"`);
  }
  for (const competitor of ['Wise', 'Revolut', 'Airwallex', 'Payoneer']) {
    assert.ok(SOKIN_ICP.includes(competitor), `default ICP does not disqualify ${competitor}`);
  }
});

console.log(`\n${checks} checks passed\n`);
