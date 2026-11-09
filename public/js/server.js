// Client for the band server (the Cloudflare Worker in worker/index.js).
// The token you get when joining is kept in this browser only.
import * as db from './store.js';

export class ApiError extends Error {
  constructor(status, message, data) { super(message); this.status = status; this.data = data; }
}

const clean = (u) => String(u || '').trim().replace(/\/+$/, '');
export const serverUrl = () => clean(db.settings.get('serverUrl', ''));
export const isJoined = () => !!(db.settings.get('token', '') && db.settings.get('serverUrl', ''));
export const memberName = () => db.settings.get('memberName', '');
export const bandName = () => db.settings.get('bandName', '');

async function request(method, path, { body, raw, headers = {}, token = db.settings.get('token', ''), base = serverUrl() } = {}) {
  if (!base) throw new ApiError(0, 'No band server address set. Open Settings.');
  const h = { ...headers };
  if (token) h.Authorization = 'Bearer ' + token;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(base + path, { method, headers: h, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError(0, 'Could not reach the band server. Check your connection.');
  }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json().catch(() => ({})) : null;
  if (res.status === 401 && token) throw new ApiError(401, 'The band no longer recognises this device. Open Settings and join again.', data);
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || `Server said ${res.status}`, data);
  return { res, data };
}

export async function join(url, code, name) {
  const base = clean(url);
  if (!/^https?:\/\//i.test(base)) throw new ApiError(0, 'The address should start with https://');
  let r;
  try { r = await request('POST', '/api/join', { base, token: '', body: { code, name } }); }
  catch (e) {
    if (e.status === 404 || e.status === 405) throw new ApiError(404, 'That address does not have a BandBook server on it.');
    throw e;
  }
  db.settings.set('serverUrl', base);
  db.settings.set('token', r.data.token);
  db.settings.set('memberName', r.data.member.name);
  db.settings.set('bandName', r.data.band || '');
  db.settings.set('syncSeq', 0);
  return r.data;
}

export async function joinWithLink(url, link) {
  const base = clean(url);
  if (!/^https?:\/\//i.test(base)) throw new ApiError(0, 'The address should start with https://');
  const r = await request('POST', '/api/join', { base, token: '', body: { link } });
  db.settings.set('serverUrl', base);
  db.settings.set('token', r.data.token);
  db.settings.set('memberName', r.data.member.name);
  db.settings.set('bandName', r.data.band || '');
  db.settings.set('syncSeq', 0);
  return r.data;
}
export const makeLinkCode = async () => (await request('POST', '/api/link')).data;

export function leave() {
  for (const k of ['token', 'memberName', 'bandName']) db.settings.set(k, '');
  db.settings.set('syncSeq', 0);
}

export const pull = async (since) => (await request('GET', '/api/sync?since=' + since)).data;
export const putSong = async (id, body) => (await request('PUT', '/api/songs/' + id, { body })).data;
export const delSong = async (id) => (await request('DELETE', '/api/songs/' + id)).data;
export const putFile = async (id, blob) => (await request('PUT', '/api/files/' + id, { raw: blob, headers: { 'X-Mime': blob.type || 'application/octet-stream', 'Content-Type': 'application/octet-stream' } })).data;
export const getFile = async (id) => (await request('GET', '/api/files/' + id)).res.blob();
export const putSet = async (id, body) => (await request('PUT', '/api/setlists/' + id, { body })).data;
export const delSet = async (id) => (await request('DELETE', '/api/setlists/' + id)).data;
export const putInk = async (songId, json) => (await request('PUT', '/api/ink/' + songId, { body: { json } })).data;
export const putFolders = async (folders) => (await request('PUT', '/api/folders', { body: { folders } })).data;
export const members = async (adminCode) => (await request('GET', '/api/members', { headers: { 'X-Admin-Code': adminCode } })).data.members;
export const removeMember = async (adminCode, id) => (await request('DELETE', '/api/members/' + id, { headers: { 'X-Admin-Code': adminCode } })).data;
