#!/usr/bin/env node
/**
 * Mint an API token for one user.
 *
 *   node scripts/mint-token.mjs <user-id> "<Display Name>" [label]
 *
 * Prints the plaintext token ONCE (paste it into the extension's Settings page)
 * and the SQL to register its hash. Only the hash is ever stored, so a lost
 * token cannot be recovered — mint a new one and deactivate the old row.
 */

import { randomBytes, createHash } from 'node:crypto';

const [userId, name, label = 'default'] = process.argv.slice(2);

if (!userId || !name) {
  console.error('usage: node scripts/mint-token.mjs <user-id> "<Display Name>" [label]');
  process.exit(1);
}

if (!/^[a-z0-9_-]+$/i.test(userId)) {
  console.error('user-id must be alphanumeric with - or _ only');
  process.exit(1);
}

const token = `snv_${randomBytes(32).toString('base64url')}`;
const hash = createHash('sha256').update(token).digest('hex');

const escape = (value) => String(value).replace(/'/g, "''");

const sql = `INSERT OR IGNORE INTO users (id, name) VALUES ('${escape(userId)}', '${escape(name)}');
INSERT INTO tokens (token_hash, user_id, label) VALUES ('${hash}', '${escape(userId)}', '${escape(label)}');`;

console.log('\n─── TOKEN (shown once — paste into the extension Settings page) ───\n');
console.log(token);
console.log('\n─── Register it ───\n');
console.log(sql);
console.log('\nRun against your database:\n');
console.log(`  npx wrangler d1 execute salesnav-enrichment --remote --command "${sql.replace(/\n/g, ' ')}"\n`);
console.log('Revoke later with:\n');
console.log(
  `  npx wrangler d1 execute salesnav-enrichment --remote --command "UPDATE tokens SET active = 0 WHERE token_hash = '${hash}'"\n`,
);
