import assert from 'node:assert/strict';
import { assess } from '../public/js/offline.js';
const good = { sw: { supported: true, controlled: true, cached: 20, total: 20 }, songs: 12, missingFiles: 0, unsynced: 0, lastSync: 1, lastSyncText: '6:30 PM', persisted: true, installed: true };
assert.equal(assess(good).level, 'ready');
assert.equal(assess({ ...good, persisted: false, installed: true }).level, 'ready');
assert.equal(assess({ ...good, persisted: false, installed: false }).level, 'check');
assert.equal(assess({ ...good, unsynced: 3 }).level, 'check');
assert.equal(assess({ ...good, missingFiles: 2 }).level, 'check');
assert.equal(assess({ ...good, sw: { supported: true, controlled: false } }).level, 'no');
assert.equal(assess({ ...good, sw: { supported: true, controlled: true, cached: 5, total: 20 } }).level, 'no');
assert.equal(assess({ ...good, sw: { supported: false } }).level, 'no');
assert.match(assess({ ...good, unsynced: 1 }).items.find((x) => x.ok === 'warn').text, /1 change not synced/);
assert.equal(assess({ ...good, lastSync: 0 }).level, 'ready'); // local-only use is fine
console.log('offline tests passed');
