// Runs on https://nfsu2.xyz/* only. Reads and writes the site's own browser storage (OPFS),
// which a content script shares with the page because it runs in the page's origin.
// It never edits bytes itself: the side panel sends finished files, and this script only
// checks that writing is safe, writes, and reads them back.
(() => {
  const ROOT_DIR = 'NFS Underground 2';
  const LOCK_PREFIX = 'nfsu2-saves:';
  const NAME_OK = /^[^\\/:*?"<>|\x00-\x1f]{1,31}$/;
  // A name a restore may create: also no "." or "..", no leading or trailing space or dot, and no invisible or
  // direction-changing characters. src/backup.js holds the same check.
  const NAME_SAFE = (s) => NAME_OK.test(s) && !/^[ .]|[ .]$/.test(s) && !/[\x7f-\x9f​-‏‪-‮⁦-⁩﻿]/.test(s);
  // The two files a write may put down, checked here too so no bad bytes reach the site's storage whatever the panel
  // sent: a career profile is 54966 bytes and starts "20CM", a GARAGE.DAT is 10202 bytes and starts "N2GA".
  const FILES = { career: { size: 54966, magic: [0x32, 0x30, 0x43, 0x4d] }, garage: { size: 10202, magic: [0x4e, 0x32, 0x47, 0x41] } };
  const shaped = (bytes, kind) => bytes.length === FILES[kind].size && FILES[kind].magic.every((b, i) => bytes[i] === b);
  // The game keeps magazine covers and DVD replays in folders beside the careers ("Zorblax77 Magazine 7", "Zorblax77 DVD 3"),
  // each with a file named after its folder that starts "20CM" too but is far larger. Only a career-shaped file makes
  // a folder a career, so nothing else is listed, read or written.
  const NOT_CAREER = (profile) => `${profile} is not a career profile (the game keeps magazine covers and DVD replays beside the careers), so the editor leaves it alone. Nothing was read or written.`;

  const toB64 = (bytes) => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const fromB64 = (text) => {
    const s = atob(text), out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  };
  const sha256 = async (bytes) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (b) => b.toString(16).padStart(2, '0')).join('');

  async function saveDirs() {
    const root = await navigator.storage.getDirectory();
    const out = [];
    for await (const [name, h] of root.entries()) if (h.kind === 'directory' && /^save(-.+)?$/.test(name)) out.push(name);
    return out.sort((a, b) => (a === 'save' ? -1 : b === 'save' ? 1 : a.localeCompare(b)));
  }

  async function profileDir(saveDir, profile, create = false) {
    if (!/^save(-.+)?$/.test(saveDir)) throw new Error('Unknown save folder.');
    if (!NAME_OK.test(profile)) throw new Error('Invalid profile name.');
    const root = await navigator.storage.getDirectory();
    const save = await root.getDirectoryHandle(saveDir);
    const nfs = await save.getDirectoryHandle(ROOT_DIR, { create });
    return nfs.getDirectoryHandle(profile);
  }

  async function readFile(dir, name) {
    try { return new Uint8Array(await (await (await dir.getFileHandle(name)).getFile()).arrayBuffer()); }
    catch (err) { if (err && err.name === 'NotFoundError') return null; throw err; }
  }

  async function listProfiles(saveDir) {
    const root = await navigator.storage.getDirectory();
    let nfs;
    try { nfs = await (await root.getDirectoryHandle(saveDir)).getDirectoryHandle(ROOT_DIR); }
    catch { return []; }
    const out = [];
    for await (const [name, h] of nfs.entries()) {
      // A name the reads would refuse (32 characters, a slash) is not listed: every read of it would fail.
      if (h.kind !== 'directory' || !NAME_OK.test(name)) continue;
      const career = await readFile(h, name);
      if (!career || !shaped(career, 'career')) continue;
      const garage = await readFile(h, 'GARAGE.DAT');
      out.push({ name, careerSize: career.length, garage: !!garage });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The Web Locks client id of this tab: hold a private lock and look up who holds it. */
  async function ownClientId() {
    const name = `nfsu2-ext-self-${crypto.randomUUID()}`;
    return navigator.locks.request(name, async () => {
      const q = await navigator.locks.query();
      return q.held.find((l) => l.name === name)?.clientId ?? null;
    });
  }

  /** Whether writing now is safe, and why not. */
  async function gate(saveDir) {
    // The site sets <body data-phase> (boot, ready, starting, playing, exited, ...). html[data-started] is set on every load, so it is no signal.
    const running = ['starting', 'playing'].includes(document.body?.dataset.phase);
    if (running) return { ok: false, running, lock: 'game', why: 'The game is running in this tab. Reload nfsu2.xyz without pressing Play, then try again.' };
    if (!navigator.locks) return { ok: true, running, lock: 'unsupported' };
    const me = await ownClientId();
    const q = await navigator.locks.query();
    const held = q.held.find((l) => l.name === LOCK_PREFIX + saveDir);
    // When this tab's own lock id or the holder's cannot be read, it cannot be told apart from another tab: refuse.
    if (held && (!me || !held.clientId)) {
      return { ok: false, running, lock: 'unknown', why: 'The editor cannot tell which nfsu2.xyz tab owns the saves, so it will not write. Close the other nfsu2.xyz tabs, reload this one, then try again.' };
    }
    if (held && held.clientId !== me) {
      return { ok: false, running, lock: 'other', why: 'Another nfsu2.xyz tab or window owns the saves. Close the other nfsu2.xyz tabs, reload this one, then try again.' };
    }
    return { ok: true, running, lock: held ? 'this-tab' : 'free' };
  }

  /**
   * The game's GLOBALB, if the site has cached all of it. Names are "<path>.<size>.<mtime>".
   * The site stores it plain (GLOBAL_GLOBALB.BUN) or JDLZ-compressed (GLOBAL_GlobalB.lzc); the panel decompresses.
   */
  async function findGameData() {
    const root = await navigator.storage.getDirectory();
    let cache;
    try { cache = await root.getDirectoryHandle('cache'); } catch { return { found: false, why: 'The site has not cached any game files yet.' }; }
    const hits = [];
    for await (const [name, h] of cache.entries()) {
      const m = h.kind === 'file' && /(^|_)GLOBALB\.(BUN|lzc)\.(\d+)\.(\d+)$/i.exec(name);
      if (m) hits.push({ name, size: Number(m[3]), plain: m[2].toUpperCase() === 'BUN' });
    }
    hits.sort((a, b) => Number(b.plain) - Number(a.plain)); // plain first: no decompression needed
    if (!hits.length) return { found: false, why: 'GLOBALB.BUN is not in the site cache yet.' };
    for (const hit of hits) {
      const bytes = await readFile(cache, hit.name);
      if (!bytes || bytes.length !== hit.size) continue;
      const have = await readFile(cache, `${hit.name}.have`);
      if (have && have.some((b) => b === 0)) continue;
      return { found: true, name: hit.name, size: hit.size, b64: toB64(bytes) };
    }
    return { found: false, why: 'GLOBALB.BUN is only partly cached. Start the game once so the site downloads it.' };
  }

  /**
   * A restore, or the Undo of one: several profiles written as one change, all or nothing. Each item is
   * { profile, mode, career, garage, expectCareerSha, expectGarageSha }:
   * - add: a new profile. No profile of that name (in any letter case) may exist.
   * - replace: an existing profile gets these files. GARAGE.DAT null means it must have none afterwards.
   * - remove: an added profile goes again (Undo of a restore), only while it is still exactly what was written.
   * replace and remove check both files against the expected shas first. Every check runs before the first byte is
   * written, and a failure part way puts every touched file and folder back.
   */
  async function restore(msg) {
    const g = await gate(msg.saveDir);
    if (!g.ok) return { ok: false, refused: true, why: g.why };
    if (!/^save(-.+)?$/.test(msg.saveDir)) throw new Error('Unknown save folder.');
    const items = Array.isArray(msg.items) ? msg.items : [];
    const no = (why) => ({ ok: false, refused: true, why: `${why} Nothing was written.` });
    if (!items.length) return no('The restore holds no profiles.');
    if (items.length > 200) return no(`The restore holds ${items.length} profiles. One restore takes at most 200.`);
    const root = await navigator.storage.getDirectory();
    const save = await root.getDirectoryHandle(msg.saveDir);
    let nfs = null;
    try { nfs = await save.getDirectoryHandle(ROOT_DIR); } catch (err) { if (err?.name !== 'NotFoundError') throw err; }
    const existing = new Map();
    if (nfs) for await (const [name, h] of nfs.entries()) if (h.kind === 'directory') existing.set(name, h);
    const lower = new Set([...existing.keys()].map((n) => n.toLowerCase()));
    const seen = new Set();
    const plan = [];
    for (const it of items) {
      const p = it?.profile;
      if (typeof p !== 'string' || !NAME_SAFE(p)) return no('A profile name in the restore is not valid.');
      if (seen.has(p.toLowerCase())) return no(`${p} appears twice in the restore.`);
      seen.add(p.toLowerCase());
      if (!['add', 'replace', 'remove'].includes(it.mode)) return no(`Unknown restore step for ${p}.`);
      const career = typeof it.career === 'string' ? fromB64(it.career) : null;
      const garage = typeof it.garage === 'string' ? fromB64(it.garage) : null;
      if (it.mode !== 'remove' && (!career || !shaped(career, 'career') || (it.garage != null && (!garage || !shaped(garage, 'garage'))))) {
        return no(`The files for ${p} are not a career save of the right size.`);
      }
      if (it.mode === 'add') {
        if (lower.has(p.toLowerCase())) return no(`A profile named ${p} already exists, so it cannot be added.`);
        plan.push({ p, mode: 'add', files: [[p, career], ...(garage ? [['GARAGE.DAT', garage]] : [])] });
        continue;
      }
      const dir = existing.get(p);
      const cur = dir ? await readFile(dir, p) : null;
      if (!cur || !shaped(cur, 'career')) return no(`${p} is not on this browser any more.`);
      const curGarage = await readFile(dir, 'GARAGE.DAT');
      if (await sha256(cur) !== it.expectCareerSha || it.expectGarageSha === undefined
        || (curGarage ? await sha256(curGarage) : null) !== it.expectGarageSha) {
        return no(`${p} changed since the restore was checked. Try again.`);
      }
      const old = { [p]: cur, 'GARAGE.DAT': curGarage };
      if (it.mode === 'remove') plan.push({ p, mode: 'remove', old, files: [[p, null], ['GARAGE.DAT', null]] });
      else plan.push({ p, mode: 'replace', old, files: [[p, career], ...(garage ? [['GARAGE.DAT', garage]] : curGarage ? [['GARAGE.DAT', null]] : [])] });
    }

    const put = async (dir, name, bytes) => {
      if (!bytes) { await dir.removeEntry(name).catch((e) => { if (e?.name !== 'NotFoundError') throw e; }); return; }
      const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await w.write(bytes);
      await w.close();
    };
    const createdRoot = !nfs;
    const touched = [], created = [], removed = [];
    // The checks above read files and hashed them: the game may have started meanwhile. Ask again right before the
    // first write.
    const again = await gate(msg.saveDir);
    if (!again.ok) return { ok: false, refused: true, why: again.why };
    try {
      if (!nfs) nfs = await save.getDirectoryHandle(ROOT_DIR, { create: true });
      for (const step of plan) {
        let dir;
        if (step.mode === 'add') { created.push(step.p); dir = await nfs.getDirectoryHandle(step.p, { create: true }); }
        else dir = await nfs.getDirectoryHandle(step.p);
        for (const [name, bytes] of step.files) {
          touched.push({ p: step.p, name, old: step.old ? step.old[name] : null });
          await put(dir, name, bytes);
        }
        // An added profile that goes again takes its folder with it, unless the game put other files there since.
        if (step.mode === 'remove') {
          let empty = true;
          for await (const _ of dir.keys()) { empty = false; break; }
          if (empty) { await nfs.removeEntry(step.p); removed.push(step.p); }
        }
      }
    } catch (err) {
      const why = String(err && err.message || err);
      let back = true;
      for (const t of touched.reverse()) {
        try {
          if (created.includes(t.p)) continue;
          await put(await nfs.getDirectoryHandle(t.p, { create: removed.includes(t.p) }), t.name, t.old);
        } catch { back = false; }
      }
      for (const p of created) { try { await nfs.removeEntry(p, { recursive: true }); } catch (e) { if (e?.name !== 'NotFoundError') back = false; } }
      if (createdRoot && nfs) { try { await save.removeEntry(ROOT_DIR); } catch { /* not empty or gone: harmless */ } }
      if (back) return { ok: false, rolledBack: true, why: `The restore failed (${why}). Every profile was put back as it was, so nothing changed.` };
      return { ok: false, partial: true, why: `The restore failed halfway (${why}) and could not all be put back. Check each profile's History.` };
    }
    const results = [];
    for (const step of plan) {
      if (step.mode === 'remove') {
        let gone = true;
        try { gone = !(await readFile(await nfs.getDirectoryHandle(step.p), step.p)); } catch (e) { if (e?.name !== 'NotFoundError') throw e; }
        results.push({ profile: step.p, removed: gone });
        continue;
      }
      const dir = await nfs.getDirectoryHandle(step.p);
      const c = await readFile(dir, step.p), gd = await readFile(dir, 'GARAGE.DAT');
      results.push({ profile: step.p, careerSha: c ? await sha256(c) : null, garageSha: gd ? await sha256(gd) : null });
    }
    return { ok: true, results };
  }

  async function handle(msg) {
    switch (msg.type) {
      case 'ping':
        return { ok: true };
      case 'status': {
        const dirs = await saveDirs();
        const saveDir = dirs.includes(msg.saveDir) ? msg.saveDir : dirs[0] ?? 'save';
        // The site's own "Free roam with others" checkbox (Online tab): an edited career joins other players when it is on.
        const roamBox = document.getElementById('set-roam');
        const roam = roamBox ? roamBox.checked : null;
        return { ok: true, saveDirs: dirs, saveDir, gate: await gate(saveDir), profiles: await listProfiles(saveDir), roam };
      }
      case 'read': {
        const dir = await profileDir(msg.saveDir, msg.profile);
        const career = await readFile(dir, msg.profile);
        if (!career) throw new Error(`${msg.profile} has no career file.`);
        if (!shaped(career, 'career')) throw new Error(NOT_CAREER(msg.profile));
        const garage = await readFile(dir, 'GARAGE.DAT');
        return { ok: true, career: toB64(career), garage: garage ? toB64(garage) : null };
      }
      case 'write': {
        const g = await gate(msg.saveDir);
        if (!g.ok) return { ok: false, refused: true, why: g.why };
        const dir = await profileDir(msg.saveDir, msg.profile);
        // The files as they should be: a career, and a GARAGE.DAT or null when the profile must have none (an Undo to a
        // point before the game made one deletes the newer file, so cars bought since do not linger in slots 6 to 10).
        const career = typeof msg.career === 'string' ? fromB64(msg.career) : null;
        const garage = typeof msg.garage === 'string' ? fromB64(msg.garage) : null;
        if (!career || !shaped(career, 'career') || (msg.garage != null && (!garage || !shaped(garage, 'garage')))) {
          return { ok: false, refused: true, why: 'The files to write are not a career save of the right size. Nothing was written.' };
        }
        // Refuse when either file changed since the panel read it (the game or another tool wrote). The garage sha is
        // null when the panel read no GARAGE.DAT, and a request without it is refused, never waved through.
        const current = await readFile(dir, msg.profile), currentGarage = await readFile(dir, 'GARAGE.DAT');
        if (current && !shaped(current, 'career')) return { ok: false, refused: true, why: NOT_CAREER(msg.profile) };
        if (!current || await sha256(current) !== msg.expectCareerSha || msg.expectGarageSha === undefined
          || (currentGarage ? await sha256(currentGarage) : null) !== msg.expectGarageSha) {
          return { ok: false, refused: true, why: 'The save changed since it was read. Nothing was written. Try again.' };
        }
        const files = [[msg.profile, career]];
        if (garage) files.push(['GARAGE.DAT', garage]);
        else if (currentGarage) files.push(['GARAGE.DAT', null]);
        const old = { [msg.profile]: current, 'GARAGE.DAT': currentGarage };
        const put = async (name, bytes) => {
          if (!bytes) { await dir.removeEntry(name).catch((e) => { if (e?.name !== 'NotFoundError') throw e; }); return; }
          const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
          await w.write(bytes);
          await w.close();
        };
        const touched = [];
        // The reads and hashes above take time: the game may have started meanwhile. Ask again right before writing.
        const again = await gate(msg.saveDir);
        if (!again.ok) return { ok: false, refused: true, why: again.why };
        try {
          for (const [name, bytes] of files) { touched.push(name); await put(name, bytes); }
        } catch (err) {
          // A failure after the career file was written would leave half an edit: put back every file this write
          // touched, so the profile is either all new or all old.
          const why = String(err && err.message || err);
          let back = true;
          for (const name of touched) {
            try {
              await put(name, old[name]);
            } catch { back = false; }
          }
          if (back) return { ok: false, rolledBack: true, why: `The write failed (${why}). Both files were put back as they were, so nothing changed.` };
          return { ok: false, partial: true, why: `The write failed halfway (${why}) and could not be put back. Use Undo on the newest history entry.` };
        }
        const backCareer = await readFile(dir, msg.profile), backGarage = await readFile(dir, 'GARAGE.DAT');
        return { ok: true, careerSha: await sha256(backCareer), garageSha: backGarage ? await sha256(backGarage) : null };
      }
      case 'restore':
        return restore(msg);
      case 'gameData':
        return { ok: true, ...(await findGameData()) };
      default:
        throw new Error(`Unknown request ${msg.type}.`);
    }
  }

  // The panel or the worker may inject this script into a tab that already runs a copy. Only the newest copy in this
  // isolated world answers, so a write is never handled twice.
  const me = Symbol('nfsu2-editor');
  globalThis.__nfsu2EditorOwner = me;

  // Tell an open panel when the site starts or stops the game (Play, quit), so its status and gate follow at once.
  // No panel open means no receiver, which is fine.
  let lastPhase = document.body?.dataset.phase;
  if (document.body) {
    new MutationObserver(() => {
      if (globalThis.__nfsu2EditorOwner !== me) return;
      const phase = document.body.dataset.phase;
      if (phase === lastPhase) return;
      lastPhase = phase;
      // A copy cut off by an extension reload throws here: it has nobody left to tell.
      try { chrome.runtime.sendMessage({ type: 'phase', phase }).catch(() => {}); } catch { /* cut off */ }
    }).observe(document.body, { attributes: true, attributeFilter: ['data-phase'] });
  }

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    if (globalThis.__nfsu2EditorOwner !== me) return false;
    if (sender.id !== chrome.runtime.id) return false;
    handle(msg).then(reply, (err) => reply({ ok: false, why: String(err && err.message || err) }));
    return true;
  });
})();
