// Google Drive client (browser-only, token flow via Google Identity Services).
// Scopes:
//   drive          - read/write song files in the shared band folder (files other members created)
//   drive.appdata  - a private per-user hidden area, used for each person's own annotations
import { settings } from './store.js';

const SCOPE = 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/drive.appdata';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
export const SONG_FILE_RE = /\.(cho|crd|chopro|chordpro|pro|txt|pdf|png|jpe?g|webp)$/i;

let token = null;
let expires = 0;

function loadGIS() {
  return new Promise((res, rej) => {
    if (window.google?.accounts?.oauth2) return res();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = () => res();
    s.onerror = () => rej(new Error('Could not load Google sign-in (are you offline?)'));
    document.head.appendChild(s);
  });
}

export const isConfigured = () => !!settings.get('clientId', '');
export const isSignedIn = () => !!token && Date.now() < expires;

export async function signIn() {
  const clientId = settings.get('clientId', '');
  if (!clientId) throw new Error('Add your Google OAuth client ID in Settings first.');
  await loadGIS();
  return new Promise((res, rej) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (r) => {
        if (r.error) return rej(new Error(r.error_description || r.error));
        token = r.access_token;
        expires = Date.now() + (Number(r.expires_in || 3600) - 60) * 1000;
        settings.set('driveLinked', true);
        res(token);
      },
      error_callback: (e) => rej(new Error(e?.type === 'popup_closed' ? 'Sign-in window was closed' : e?.message || 'Sign-in failed')),
    });
    client.requestAccessToken({ prompt: settings.get('driveLinked', false) ? '' : 'consent' });
  });
}

export function signOut() {
  if (token && window.google?.accounts?.oauth2) window.google.accounts.oauth2.revoke(token, () => {});
  token = null; expires = 0;
  settings.set('driveLinked', false);
}

async function api(url, opts = {}, retry = true) {
  const t = isSignedIn() ? token : await signIn();
  const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + t } });
  if (r.status === 401 && retry) { token = null; return api(url, opts, false); }
  if (!r.ok) throw new Error(`Drive error ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r;
}

export function folderIdFromInput(s) {
  s = String(s || '').trim();
  const m = s.match(/\/folders\/([\w-]+)/) || s.match(/[?&]id=([\w-]+)/);
  return m ? m[1] : /^[\w-]{10,}$/.test(s) ? s : '';
}

export async function whoAmI() {
  const r = await api(`${API}/about?fields=user(displayName,emailAddress)`);
  return (await r.json()).user;
}

async function list(q, extra = '') {
  const files = [];
  let pageToken = '';
  do {
    const url = `${API}/files?q=${encodeURIComponent(q)}&pageSize=1000&fields=nextPageToken,files(id,name,modifiedTime,mimeType)` +
      `&supportsAllDrives=true&includeItemsFromAllDrives=true${extra}${pageToken ? '&pageToken=' + pageToken : ''}`;
    const j = await (await api(url)).json();
    files.push(...(j.files || []));
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return files;
}

export async function listFolder(folderId) {
  const files = await list(`'${folderId}' in parents and trashed=false`);
  return files.filter((f) => f.mimeType !== 'application/vnd.google-apps.folder' && SONG_FILE_RE.test(f.name));
}

export async function listSetlists(folderId) {
  const files = await list(`'${folderId}' in parents and trashed=false`);
  return files.filter((f) => /\.setlist\.json$/i.test(f.name));
}

export const listAppData = () => list('trashed=false', '&spaces=appDataFolder');

export async function downloadText(id) {
  return (await api(`${API}/files/${id}?alt=media&supportsAllDrives=true`)).text();
}

export async function downloadBlob(id) {
  return (await api(`${API}/files/${id}?alt=media&supportsAllDrives=true`)).blob();
}

// Upload binary content (PDF / image). Uses a multipart body built from a Blob.
export async function createBlob(name, blob, parent) {
  const form = new Blob([
    `--bbx\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [parent] })}\r\n--bbx\r\nContent-Type: ${blob.type || 'application/octet-stream'}\r\n\r\n`,
    blob,
    '\r\n--bbx--',
  ]);
  const r = await api(`${UPLOAD}/files?uploadType=multipart&supportsAllDrives=true&fields=id,modifiedTime`, {
    method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=bbx' }, body: form,
  });
  return r.json();
}

function multipart(meta, text, mime) {
  const b = 'bb' + Math.random().toString(36).slice(2);
  return {
    type: `multipart/related; boundary=${b}`,
    body: `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\nContent-Type: ${mime}; charset=UTF-8\r\n\r\n${text}\r\n--${b}--`,
  };
}

export async function createText(name, text, parent, mime = 'text/plain') {
  const m = multipart({ name, parents: [parent] }, text, mime);
  const r = await api(`${UPLOAD}/files?uploadType=multipart&supportsAllDrives=true&fields=id,modifiedTime`, {
    method: 'POST', headers: { 'Content-Type': m.type }, body: m.body,
  });
  return r.json();
}

export async function updateText(id, text, mime = 'text/plain') {
  const r = await api(`${UPLOAD}/files/${id}?uploadType=media&supportsAllDrives=true&fields=id,modifiedTime`, {
    method: 'PATCH', headers: { 'Content-Type': mime + '; charset=UTF-8' }, body: text,
  });
  return r.json();
}

export async function createFolder(name, parent) {
  const r = await api(`${API}/files?fields=id,webViewLink&supportsAllDrives=true`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', ...(parent ? { parents: [parent] } : {}) }),
  });
  return r.json();
}

export const listSubfolders = (parentId) =>
  list(`'${parentId}' in parents and trashed=false and mimeType='application/vnd.google-apps.folder'`);

export async function findOrCreateFolder(name, parentId) {
  const hit = (await listSubfolders(parentId)).find((f) => f.name === name);
  return hit ? hit.id : (await createFolder(name, parentId)).id;
}

export async function moveFile(id, addParent, removeParent) {
  const r = await api(`${API}/files/${id}?addParents=${addParent}&removeParents=${removeParent}&supportsAllDrives=true&fields=id,modifiedTime`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  return r.json();
}
