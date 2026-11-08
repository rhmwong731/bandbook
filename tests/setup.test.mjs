import assert from 'node:assert/strict';
import { parseWorkersUrl, setTomlValue, randomCode } from '../worker/setup.mjs';
import { readFileSync } from 'node:fs';

assert.equal(parseWorkersUrl('Deployed bandbook triggers (1.2 sec)\n  https://bandbook.raph.workers.dev\nCurrent Version ID'), 'https://bandbook.raph.workers.dev');
assert.equal(parseWorkersUrl('nothing'), '');
const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
const a = setTomlValue(toml, 'd1_databases', 'database_id', 'abcd1234-0000-0000-0000-000000000001');
assert.match(a, /database_id = "abcd1234-0000-0000-0000-000000000001"/);
const b = setTomlValue(a, 'kv_namespaces', 'id', 'f'.repeat(32));
assert.match(b, /\[\[kv_namespaces\]\]\nbinding = "FILES"\nid = "f{32}"/);
assert.match(b, /database_id = "abcd1234/, 'earlier edit kept');
assert.throws(() => setTomlValue(toml, 'nope', 'id', 'x'));
assert.equal(randomCode(8).length, 8);
assert.notEqual(randomCode(8), randomCode(8));
console.log('setup helper tests passed');
