#!/usr/bin/env node
// One-time setup of the BandBook server on your own free Cloudflare account.
//   npm install
//   npm run setup
// It logs you in to Cloudflare, creates the database and file store, deploys the app and sets your invite code.
// Safe to run again: it reuses what already exists and keeps existing members.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOML = join(ROOT, 'wrangler.toml');
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const HEX32 = /\b[0-9a-f]{32}\b/i;

export function parseWorkersUrl(out) { return (String(out).match(/https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev/i) || [])[0] || ''; }
export function setTomlValue(toml, section, key, value) {
  // replaces `key = "..."` inside the given [section] / [[section]] block
  const re = new RegExp(`(\\[\\[?${section}\\]?\\][^\\[]*?\\b${key}\\s*=\\s*)"[^"]*"`, 's');
  if (!re.test(toml)) throw new Error(`wrangler.toml has no ${key} under ${section}`);
  return toml.replace(re, `$1"${value}"`);
}
export const randomCode = (n) => { const a = 'abcdefghjkmnpqrstuvwxyz23456789'; return [...randomBytes(n)].map((b) => a[b % a.length]).join(''); };

function wr(args, { input, quiet = false, allowFail = false } = {}) {
  const r = spawnSync('npx', ['wrangler', ...args], { cwd: ROOT, input, encoding: 'utf8', shell: process.platform === 'win32' });
  const out = (r.stdout || '') + (r.stderr || '');
  if (!quiet && out.trim()) process.stdout.write(out.endsWith('\n') ? out : out + '\n');
  if (r.status !== 0 && !allowFail) throw new Error(`wrangler ${args.join(' ')} failed`);
  return { ok: r.status === 0, out };
}

async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q, d = '') => ((await rl.question(d ? `${q} [${d}]: ` : `${q}: `)).trim() || d);

  console.log('\nBandBook setup\n');
  console.log('1/6  Checking your Cloudflare login...');
  if (!wr(['whoami'], { quiet: true, allowFail: true }).out.match(/associated with the email|You are logged in/i)) {
    console.log('     A browser window will open. Sign in (or create a free account) and click Allow.');
    wr(['login']);
  }

  let toml = readFileSync(TOML, 'utf8');

  console.log('2/6  Database...');
  let dbId = (toml.match(/database_id\s*=\s*"([^"]+)"/) || [])[1];
  if (!dbId || /^0+-/.test(dbId)) {
    const made = wr(['d1', 'create', 'bandbook'], { allowFail: true });
    dbId = (made.out.match(UUID) || [])[0];
    if (!dbId) { // it may already exist
      const list = wr(['d1', 'list', '--json'], { quiet: true, allowFail: true }).out;
      try { dbId = JSON.parse(list.slice(list.indexOf('['))).find((d) => d.name === 'bandbook')?.uuid; } catch { /* fall through */ }
    }
    if (!dbId) dbId = await ask('Could not read the database id. Paste it here');
    toml = setTomlValue(toml, 'd1_databases', 'database_id', dbId);
  }

  console.log('3/6  File storage...');
  let kvId = (toml.match(/\[\[kv_namespaces\]\][^\[]*?\bid\s*=\s*"([^"]+)"/s) || [])[1];
  if (!kvId || /^0+$/.test(kvId)) {
    const made = wr(['kv', 'namespace', 'create', 'FILES'], { allowFail: true });
    kvId = (made.out.match(HEX32) || [])[0];
    if (!kvId) {
      const list = wr(['kv', 'namespace', 'list'], { quiet: true, allowFail: true }).out;
      try { kvId = JSON.parse(list.slice(list.indexOf('['))).find((k) => /FILES$/.test(k.title))?.id; } catch { /* fall through */ }
    }
    if (!kvId) kvId = await ask('Could not read the storage id. Paste it here');
    toml = setTomlValue(toml, 'kv_namespaces', 'id', kvId);
  }

  const bandName = await ask('4/6  What is your band called?', (toml.match(/BAND_NAME\s*=\s*"([^"]*)"/) || [])[1] || 'Our Band');
  toml = toml.replace(/(BAND_NAME\s*=\s*)"[^"]*"/, `$1"${bandName.replace(/"/g, '')}"`);
  writeFileSync(TOML, toml);

  console.log('5/6  Creating the tables...');
  wr(['d1', 'execute', 'bandbook', '--remote', '--file=worker/schema.sql']);

  console.log('6/6  Deploying the app...');
  let dep = wr(['deploy'], { allowFail: true });
  for (let tries = 0; !dep.ok && /workers\.dev subdomain/i.test(dep.out) && tries < 3; tries++) {
    const page = (dep.out.match(/https:\/\/dash\.cloudflare\.com\/\S+\/workers\/onboarding/) || ['https://dash.cloudflare.com/?to=/:account/workers/onboarding'])[0];
    console.log('\n     Cloudflare needs a free address for your band first (a one-time step).');
    console.log('     Open this page, pick any name (e.g. your band name) and save it:\n       ' + page);
    await ask('     Press Enter here once you have saved it');
    dep = wr(['deploy'], { allowFail: true });
  }
  if (!dep.ok) throw new Error('wrangler deploy failed');
  const url = parseWorkersUrl(dep.out);

  const invite = await ask('\nInvite code for your bandmates (they type this once to join)', randomCode(6));
  const adminCode = await ask('Admin code (only you; lets you remove members)', randomCode(8));
  wr(['secret', 'put', 'INVITE_CODE'], { input: invite + '\n', quiet: true });
  wr(['secret', 'put', 'ADMIN_CODE'], { input: adminCode + '\n', quiet: true });
  rl.close();

  console.log(`
Done.

  Band address : ${url || '(see the "Deployed" line above)'}
  Invite code  : ${invite}
  Admin code   : ${adminCode}

Send your bandmates the address and the invite code. On their phone: open the address, add it to the
home screen, then Settings > Your band > enter the code and their name > Join band > Sync.
Songs reach the band once they are shared (More > Share with the band, or Settings > Your band > Share all local songs).
A second device of your own: Settings > Your band > Link another device gives a code to type on the other device.
Keep the admin code to yourself. Write both codes down: they are not shown again.
`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((e) => { console.error('\nSetup stopped: ' + e.message); process.exit(1); });
