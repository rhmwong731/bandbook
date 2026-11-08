// "Ready for offline" check. assess() is pure (unit tested); the page gathers the inputs.
// level: 'ready' (all good), 'check' (works, but something to look at), 'no' (will not load without internet)

export function assess(i) {
  const items = [];
  const add = (ok, text, hint = '') => items.push({ ok, text, hint });
  const sw = i.sw || {};

  if (!sw.supported) add(false, 'Offline mode is not available in this browser or page.', 'Open the app from its https address in Safari or Chrome.');
  else if (!sw.controlled) add(false, 'App not saved for offline yet.', 'Open it once while online, then reload.');
  else if (sw.total && sw.cached < sw.total) add(false, `App files saved: ${sw.cached} of ${sw.total}.`, 'Stay online a little longer, then reopen the app.');
  else add(true, 'App and PDF engine saved on this device.');

  if (i.missingFiles > 0) add('warn', `${i.missingFiles} PDF/image song${i.missingFiles > 1 ? 's' : ''} missing the file on this device.`, 'Tap Sync while online to download them.');
  else add(true, `${i.songs} song${i.songs === 1 ? '' : 's'} stored on this device.`);

  if (i.unsynced > 0) add('warn', `${i.unsynced} change${i.unsynced > 1 ? 's' : ''} not synced to Drive yet.`, 'Safe on this device. Sync when you are back online.');
  else if (i.lastSync) add(true, 'Last synced ' + i.lastSyncText + '.');
  else add(true, 'Not synced with Drive yet (songs are local only).');

  if (i.persisted) add(true, 'Storage is protected from being cleared.');
  else if (i.installed) add(true, 'Installed on the home screen (the browser keeps its data).');
  else add('warn', 'Not installed to the home screen.', 'Browsers may clear data of sites left unused. Use Add to Home Screen, and keep a backup.');

  const broken = items.slice(0, 1).some((x) => x.ok === false);
  const warns = items.some((x) => x.ok === 'warn');
  const level = broken ? 'no' : warns ? 'check' : 'ready';
  const label = { ready: 'Ready for offline', check: 'Offline: check', no: 'Not ready for offline' }[level];
  return { level, label, items };
}
