// Live check that only real careers are profiles. The game keeps magazine covers and DVD replays in folders beside
// the careers ("Zorblax77 Magazine 7", "Zorblax77 DVD 5"), each with a file named after its folder that starts "20CM" like a
// career but is far larger. Those folders must not be listed, and a read or a write naming one is refused with the
// files left as they were. The cover and replay files here are made up (a "20CM" header and zeros), never game data.
// Usage: node test/live-profiles.cjs <playwright module dir> <test profile folder> <out dir> [extension dir]
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const [pwDir, profDir, outDir, extArg] = process.argv.slice(2);
if (!outDir) { console.error('usage: node test/live-profiles.cjs <playwright dir> <profile folder> <out dir> [extension dir]'); process.exit(2); }
const { chromium } = require(pwDir);
const EXT = path.resolve(extArg || path.join(__dirname, '..'));
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const NAME = path.basename(profDir);
const sha = (b) => crypto.createHash('sha256').update(Buffer.from(b)).digest('hex');
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`); };

// A made-up non-career save: "20CM", its own length as the header's size field, then zeros.
const fake = (size) => { const b = Buffer.alloc(size); b.write('20CM', 0, 'latin1'); b.writeUInt32LE(size, 4); b.writeUInt32LE(8, 8); return [...b]; };
const OTHERS = { [`${NAME} DVD 5`]: 1048612, [`${NAME} Magazine 7`]: 196644, [`${NAME} Magazine 8`]: 196644, 'Quillon42 Magazine 3': 196644 };

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nfsu2-ext-profiles-'));
  const ctx = await chromium.launchPersistentContext(userDir, {
    headless: true, executablePath: CHROME, viewport: { width: 1280, height: 800 },
    ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging'],
  });
  try {
    const site = ctx.pages()[0] || await ctx.newPage();
    site.on('dialog', (d) => d.dismiss().catch(() => {}));
    await site.goto('https://nfsu2.xyz/', { waitUntil: 'load', timeout: 60000 });
    const folders = { [NAME]: { [NAME]: [...fs.readFileSync(path.join(profDir, NAME))], 'GARAGE.DAT': [...fs.readFileSync(path.join(profDir, 'GARAGE.DAT'))] } };
    for (const [name, size] of Object.entries(OTHERS)) folders[name] = { [name]: fake(size) };
    await site.evaluate(async (folders) => {
      const nfs = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('save', { create: true })).getDirectoryHandle('NFS Underground 2', { create: true });
      for (const [folder, files] of Object.entries(folders)) {
        const dir = await nfs.getDirectoryHandle(folder, { create: true });
        for (const [n, bytes] of Object.entries(files)) { const w = await (await dir.getFileHandle(n, { create: true })).createWritable(); await w.write(new Uint8Array(bytes)); await w.close(); }
      }
    }, folders);
    await site.reload({ waitUntil: 'load' });
    await site.waitForTimeout(2500);
    const fileSha = (folder) => site.evaluate(async (folder) => {
      const dir = await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle('save')).getDirectoryHandle('NFS Underground 2')).getDirectoryHandle(folder);
      const names = []; for await (const [n] of dir.entries()) names.push(n);
      const bytes = new Uint8Array(await (await (await dir.getFileHandle(folder)).getFile()).arrayBuffer());
      return { names: names.sort(), sha: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('') };
    }, folder);

    await (await ctx.browser().newBrowserCDPSession()).send('Extensions.loadUnpacked', { path: EXT });
    const isExt = (w) => w.url().startsWith('chrome-extension://');
    let sw = ctx.serviceWorkers().find(isExt);
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { predicate: isExt, timeout: 15000 });
    const extId = new URL(sw.url()).host;
    // The offline-only notice is confirmed up front; test/live-ack.cjs tests the notice itself.
    await sw.evaluate(() => chrome.storage.local.set({ offlineAck: { version: 1, at: 0 } }));
    await site.waitForTimeout(1500);
    const panel = await ctx.newPage();
    await panel.setViewportSize({ width: 400, height: 1000 });
    await panel.goto(`chrome-extension://${extId}/panel/panel.html`);
    await panel.waitForFunction(() => /safe to edit/.test(document.getElementById('conn').textContent), null, { timeout: 20000 });
    const ask = (msg) => panel.evaluate(async (msg) => {
      const [tab] = await chrome.tabs.query({ url: 'https://nfsu2.xyz/*' });
      return chrome.tabs.sendMessage(tab.id, msg);
    }, msg);

    const status = await ask({ type: 'status', saveDir: 'save' });
    const listed = (status.profiles || []).map((p) => p.name);
    check('only the career is listed; magazine covers and DVD replays are not', listed.length === 1 && listed[0] === NAME, JSON.stringify(listed));
    const options = await panel.$$eval('#profile option', (os) => os.map((o) => o.value));
    check('the Profile dropdown and header show one profile', options.length === 1 && options[0] === NAME && /1 profile\b/.test(await panel.textContent('#conn')), `${JSON.stringify(options)} | ${await panel.textContent('#conn')}`);
    await panel.screenshot({ path: path.join(outDir, 'profiles-400.png') });

    const dvd = `${NAME} DVD 5`, before = await fileSha(dvd);
    const read = await ask({ type: 'read', saveDir: 'save', profile: dvd });
    check('a read naming a DVD replay folder is refused', read?.ok === false && /not a career profile/.test(read.why) && !('career' in read), JSON.stringify(read).slice(0, 140));
    // A well-formed career sent to the DVD folder, with the sha of what is there, as a write that passed every other check.
    const career = fs.readFileSync(path.join(profDir, NAME));
    const write = await ask({ type: 'write', saveDir: 'save', profile: dvd, expectCareerSha: before.sha, expectGarageSha: null, career: career.toString('base64'), garage: null });
    const after = await fileSha(dvd);
    check('a write naming a DVD replay folder is refused and leaves it as it was', write?.ok === false && write.refused === true && /not a career profile/.test(write.why)
      && after.sha === before.sha && JSON.stringify(after.names) === JSON.stringify(before.names), `${JSON.stringify(write).slice(0, 120)} | ${JSON.stringify(after.names)}`);
    const mag = await ask({ type: 'read', saveDir: 'save', profile: 'Quillon42 Magazine 3' });
    check('a read naming a magazine cover folder is refused', mag?.ok === false && /not a career profile/.test(mag.why), JSON.stringify(mag).slice(0, 120));
    const own = await ask({ type: 'read', saveDir: 'save', profile: NAME });
    check('the career itself still reads', own?.ok === true && Buffer.from(own.career, 'base64').length === 54966);
  } catch (err) {
    check('live profiles run', false, String(err && err.stack || err));
  } finally {
    await ctx.close();
    console.log(`\n${pass}/${pass + fail} pass`);
    process.exitCode = fail ? 1 : 0;
  }
})();
