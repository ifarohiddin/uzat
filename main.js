'use strict';
const { app, BrowserWindow, ipcMain, desktopCapturer, session, Notification, nativeTheme, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { Discovery } = require('./core/discovery');
const signal = require('./core/signal');
const { WebShare } = require('./core/web');
const { Input } = require('./core/input');
const { SSDP } = require('./core/ssdp');
const dlna = require('./core/dlna');

// Lokal tarmoqda WebRTC to'g'ridan-to'g'ri IP orqali ulansin (mDNS niqobisiz) va video ovozi o'zi ijro etilsin.
app.commandLine.appendSwitch(
  'disable-features',
  // Sinovda harakat oynasi boshqa oynalar ostida qolsa ham chizilaversin.
  process.env.UZAT_E2E ? 'WebRtcHideLocalIpsWithMdns,CalculateNativeWinOcclusion' : 'WebRtcHideLocalIpsWithMdns'
);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Sinov uchun: UZAT_PROFILE=nom bilan bir kompyuterda ikkinchi nusxani alohida sozlamalar bilan ochish mumkin.
const PROFILE = process.env.UZAT_PROFILE;
if (PROFILE) app.setPath('userData', path.join(app.getPath('appData'), 'Uzat-' + PROFILE.replace(/[^\w-]/g, '')));
else if (!app.requestSingleInstanceLock()) app.quit();
app.setAppUserModelId('uz.uzat.app');
nativeTheme.themeSource = 'dark';

const E2E = process.env.UZAT_E2E; // 'share' | 'view' — faqat avtomatik sinov uchun

// ---------- Sozlamalar ----------
const cfgPath = () => path.join(app.getPath('userData'), 'config.json');
let cfg = {};
function loadCfg() {
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath(), 'utf8'));
  } catch {
    cfg = {};
  }
  if (!cfg.id) cfg.id = crypto.randomUUID();
  if (process.env.UZAT_NAME) cfg.name = process.env.UZAT_NAME;
  if (!cfg.name) cfg.name = os.hostname();
  if (!Array.isArray(cfg.trusted)) cfg.trusted = [];
  if (!['fast', 'balanced', 'sharp'].includes(cfg.quality)) cfg.quality = 'balanced';
  if (typeof cfg.audio !== 'boolean') cfg.audio = false;
  if (typeof cfg.control !== 'boolean') cfg.control = false; // masofadan boshqarish — faqat foydalanuvchi yoqsa
  saveCfg();
}
function saveCfg() {
  try {
    fs.mkdirSync(path.dirname(cfgPath()), { recursive: true });
    fs.writeFileSync(cfgPath(), JSON.stringify(cfg, null, 2));
  } catch {}
}

let win = null;
let discovery = null;
let selectedSourceId = null;
let out = null; // biz ulashayotgan sessiya: { line, peer }
const viewers = new Map(); // webContents.id -> { win, line, from, sid }
const pendingAsks = new Map(); // sid -> resolve(accept)

const send = (ch, data) => {
  if (win && !win.isDestroyed()) win.webContents.send(ch, data);
  if (E2E) e2eLog(ch, data);
};

const winOpts = (extra) => ({
  backgroundColor: '#15171c',
  titleBarStyle: 'hidden',
  titleBarOverlay: { color: '#15171c', symbolColor: '#8b919c', height: 36 },
  show: false,
  webPreferences: {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    spellcheck: false,
    backgroundThrottling: false, // fon rejimida ham kadrlar sekinlashmasin
  },
  ...extra,
});

function lockDown(w) {
  w.setMenu(null);
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e) => e.preventDefault());
}

function createWindow() {
  win = new BrowserWindow(winOpts({ width: 460, height: 780, minWidth: 400, minHeight: 680, title: 'Uzat' }));
  lockDown(win);
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'src', 'index.html'), E2E ? { hash: 'e2e' } : undefined);
  win.on('closed', () => {
    win = null;
    for (const v of viewers.values()) if (!v.win.isDestroyed()) v.win.close();
  });
}

// ---------- Ekran tanlash ----------
async function listSources(thumbs = true) {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: thumbs ? { width: 480, height: 270 } : { width: 0, height: 0 },
  });
  const displays = screen.getAllDisplays();
  return sources
    .filter((s) => s.name && !/^Uzat$/.test(s.name))
    .map((s, i) => {
      const isScreen = s.id.startsWith('screen:');
      let name = s.name;
      if (isScreen) {
        const idx = displays.findIndex((d) => String(d.id) === s.display_id);
        name = displays.length > 1 ? `Ekran ${idx >= 0 ? idx + 1 : i + 1}` : 'Butun ekran';
      }
      return { id: s.id, name, kind: isScreen ? 'screen' : 'window', thumb: thumbs ? s.thumbnail.toDataURL() : null, _src: s };
    });
}

function installCaptureHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_req, callback) => {
      try {
        const list = await listSources(false);
        let pick = list.find((s) => s.id === selectedSourceId) || list.find((s) => s.kind === 'screen') || list[0];
        if ((E2E === 'share' || E2E === 'web') && !process.env.UZAT_E2E_SCREEN) pick = list.find((s) => s.name === 'E2E harakat') || pick;
        if (!pick) return callback({});
        captured = { kind: pick.kind, displayId: pick._src.display_id, name: pick.name };
        // Windows'da tizim ovozini "loopback" orqali olish mumkin.
        callback(cfg.audio && process.platform === 'win32' ? { video: pick._src, audio: 'loopback' } : { video: pick._src });
      } catch {
        callback({});
      }
    },
    { useSystemPicker: false }
  );
}

// ---------- Masofadan boshqarish ----------
// Ko'ruvchi (masalan, Android ekranidagi teginish) 0..1 oralig'idagi koordinata yuboradi;
// biz uni ulashilayotgan monitorning jismoniy piksellariga aylantiramiz.
let captured = null; // { kind, displayId, name }
let input = null;
const held = new Set();

function capturedRect() {
  if (!captured || captured.kind !== 'screen') return null;
  const displays = screen.getAllDisplays();
  const d = displays.find((x) => String(x.id) === String(captured.displayId)) || (displays.length === 1 ? displays[0] : null);
  if (!d) return null;
  return process.platform === 'win32' ? screen.dipToScreenRect(null, d.bounds) : d.bounds;
}

const VK_ALLOWED = new Set([8, 9, 13, 27, 32, 33, 34, 35, 36, 37, 38, 39, 40, 46, 91]);

async function handleInput(m) {
  if (!cfg.control || !m || typeof m.t !== 'string') return;
  if (!input) {
    input = new Input(
      path.join(__dirname, 'native', 'input.cs'),
      path.join(app.getPath('userData'), 'bin'),
      app.isPackaged ? path.join(__dirname, 'native', 'uzat-input.exe') : null
    );
  }
  try {
    await input.start();
  } catch (e) {
    send('net:error', e.message);
    return;
  }
  if (m.t === 'p') {
    const r = capturedRect();
    if (!r) return send('control:unsupported');
    const x = Math.min(1, Math.max(0, Number(m.x)));
    const y = Math.min(1, Math.max(0, Number(m.y)));
    if (!isFinite(x) || !isFinite(y)) return;
    const px = Math.round(r.x + x * (r.width - 1));
    const py = Math.round(r.y + y * (r.height - 1));
    input.move(px, py);
    if (E2E) console.log(`[e2e:input] ${m.a} ${px} ${py}`);
    const b = m.b === 'r' ? 'r' : m.b === 'm' ? 'm' : 'l';
    if (m.a === 'down' && !held.has(b)) {
      held.add(b);
      input.down(b);
    } else if (m.a === 'up' && held.has(b)) {
      held.delete(b);
      input.up(b);
    } else if (m.a === 'click') {
      input.down(b);
      input.up(b);
    }
  } else if (m.t === 'w') {
    input.wheel(Math.max(-1200, Math.min(1200, Number(m.dy) || 0)), Math.max(-1200, Math.min(1200, Number(m.dx) || 0)));
  } else if (m.t === 'k' && VK_ALLOWED.has(Number(m.vk))) {
    input.key(Number(m.vk));
  } else if (m.t === 'txt' && typeof m.s === 'string') {
    input.text(m.s.slice(0, 2000));
  }
}

function releaseInput() {
  if (input) for (const b of held) input.up(b);
  held.clear();
}

ipcMain.on('input', (_e, m) => handleInput(m));
ipcMain.handle('input:release', () => releaseInput());
ipcMain.handle('control:capable', () => !!capturedRect());

// ---------- Ko'rish oynasi (biz qabul qilganda) ----------
function openViewer(line, from, sid) {
  const wa = screen.getPrimaryDisplay().workAreaSize;
  const w = Math.min(1280, Math.round(wa.width * 0.8));
  const h = Math.min(760, Math.round(wa.height * 0.8));
  const vw = new BrowserWindow(
    winOpts({
      width: w,
      height: h,
      minWidth: 480,
      minHeight: 300,
      title: `${from} — Uzat`,
      backgroundColor: '#000000',
      titleBarOverlay: { color: '#00000000', symbolColor: '#c9ccd2', height: 36 },
    })
  );
  lockDown(vw);
  // Oyna yuklanguncha kelgan xabarlarni navbatda saqlaymiz, aks holda SDP taklifi yo'qolib qoladi.
  const v = { win: vw, line, from, sid, ready: false, queue: [], ended: false };
  viewers.set(vw.webContents.id, v);
  vw.once('ready-to-show', () => {
    vw.show();
    vw.focus();
  });
  vw.loadFile(path.join(__dirname, 'src', 'viewer.html'));

  const deliver = (ch, data) => {
    if (vw.isDestroyed()) return;
    if (!v.ready) return v.queue.push([ch, data]);
    vw.webContents.send(ch, data);
  };
  line.on('message', (m) => {
    if (m.t === 'bye') return deliver('viewer:ended');
    deliver('viewer:signal', m);
  });
  line.on('close', () => deliver('viewer:ended'));
  vw.on('closed', () => {
    viewers.delete(v.id);
    line.send({ t: 'bye' });
    line.close();
  });
  v.id = vw.webContents.id;
  if (E2E === 'view') e2eViewer(vw);
}

async function onIncoming(line) {
  let hello;
  try {
    hello = await line.next(['hello'], 10000);
  } catch {
    return line.close();
  }
  const sid = crypto.randomUUID();
  const ask = {
    sid,
    from: String(hello.from || 'Kompyuter').slice(0, 40),
    fromId: String(hello.fromId || '').slice(0, 64),
    source: String(hello.source || '').slice(0, 80),
    address: line.remoteAddress,
  };
  let accept;
  if (ask.fromId && cfg.trusted.includes(ask.fromId)) {
    accept = true;
  } else {
    send('share:ask', ask);
    attention(`${ask.from} ekranini ko'rsatmoqchi`, 'Ochib, «Ko‘rish» ni bosing');
    accept = await new Promise((resolve) => {
      pendingAsks.set(sid, resolve);
      line.once('close', () => {
        if (pendingAsks.delete(sid)) {
          send('share:ask-cancelled', { sid });
          resolve(false);
        }
      });
    });
  }
  if (!accept || line.closed) {
    line.send({ t: 'reject' });
    return line.close();
  }
  line.send({ t: 'accept' });
  openViewer(line, ask.from, sid);
}

function attention(title, body) {
  if (!win || win.isFocused()) return;
  win.flashFrame(true);
  if (Notification.isSupported()) {
    const n = new Notification({ title, body });
    n.on('click', () => {
      win.show();
      win.focus();
    });
    n.show();
  }
}

let web = null;
async function startWeb() {
  web = new WebShare(__dirname);
  web.on('join', (d) => send('web:join', d));
  web.on('signal', (d) => send('web:signal', d));
  web.on('leave', (d) => send('web:leave', d));
  await web.listen(Number(process.env.UZAT_WEB_PORT || 8090));
}

ipcMain.handle('web:start', () => {
  if (!web || !web.port) return { ok: false, error: 'Veb-server ishlamayapti' };
  const pin = web.open(cfg.name);
  return { ok: true, pin, urls: web.urls(), port: web.port };
});
ipcMain.handle('web:stop', () => {
  releaseInput();
  if (web) web.close();
});
ipcMain.handle('web:signal', (_e, { vid, m }) => web && web.send(vid, m));
ipcMain.handle('web:kick', (_e, vid) => web && web.drop(vid, 'bye'));

// ---------- DLNA (Android head unit, televizor) ----------
let ssdp = null;
let dlnaActive = null; // { dev, timer, playing }
const allPeers = () => [...(discovery ? discovery.list().map((p) => ({ ...p, kind: 'uzat' })) : []), ...(ssdp ? ssdp.list() : [])];

ipcMain.handle('dlna:start', async (_e, { peerId, mime, ext }) => {
  const dev = ssdp && ssdp.get(peerId);
  if (!dev) return { ok: false, error: 'Qurilma topilmadi' };
  if (!web || !web.port) return { ok: false, error: 'Veb-server ishlamayapti' };
  const httpMime = String(mime).split(';')[0];
  const token = web.openLive(httpMime);
  const url = `http://${web.addressFor(dev.address)}:${web.port}/live/${token}.${String(ext).replace(/\W/g, '')}`;
  try {
    await dlna.play(dev.control, url, `${cfg.name} ekrani`, httpMime);
  } catch (e) {
    web.closeLive();
    return { ok: false, error: `${dev.name} buyruqni qabul qilmadi: ${e.message}` };
  }
  // Qurilma holatini kuzatamiz: foydalanuvchi u yerda to'xtatsa, biz ham to'xtatamiz.
  const a = { dev, playing: false, idle: 0 };
  a.timer = setInterval(async () => {
    const st = await dlna.state(dev.control).catch(() => 'UNKNOWN');
    if (st === 'PLAYING') a.playing = true;
    if (a.playing && (st === 'STOPPED' || st === 'NO_MEDIA_PRESENT')) a.idle++;
    else a.idle = 0;
    send('dlna:state', { state: st });
    if (a.idle >= 2) endDlna(true);
  }, 2000);
  dlnaActive = a;
  return { ok: true, url };
});

function endDlna(remote) {
  const a = dlnaActive;
  dlnaActive = null;
  if (web) web.closeLive();
  if (!a) return;
  clearInterval(a.timer);
  if (!remote) dlna.stop(a.dev.control).catch(() => {});
  else send('dlna:ended', { name: a.dev.name });
}
ipcMain.handle('dlna:stop', () => endDlna(false));
ipcMain.on('rec:chunk', (_e, { rid, buf }) => {
  if (web && buf) web.writeLive(rid, Buffer.from(buf));
});

async function startNetwork() {
  startWeb()
    .then(() => {
      web.on('live:open', (d) => send('rec:start', d));
      web.on('live:close', (d) => send('rec:stop', d));
    })
    .catch((e) => send('net:error', `Veb-server: ${e.message}`));
  ssdp = new SSDP();
  ssdp.on('change', () => send('peers', allPeers()));
  ssdp.start();
  const { port } = await signal.listen((line) => onIncoming(line));
  discovery = new Discovery({ id: cfg.id, name: cfg.name, port });
  discovery.on('change', () => send('peers', allPeers()));
  discovery.on('error', (e) => send('net:error', String(e.message || e)));
  discovery.start();
}

// ---------- IPC: asosiy oyna ----------
ipcMain.handle('self', () => ({
  id: cfg.id,
  name: cfg.name,
  quality: cfg.quality,
  audio: cfg.audio,
  control: cfg.control,
  dlnaFormat: process.env.UZAT_DLNA_FMT || cfg.dlnaFormat || null,
}));
ipcMain.handle('peers', () => allPeers());
ipcMain.handle('rename', (_e, name) => {
  name = String(name || '').trim().slice(0, 40);
  if (!name) return cfg.name;
  cfg.name = name;
  saveCfg();
  if (discovery) discovery.setName(name);
  return name;
});
ipcMain.handle('prefs', (_e, p) => {
  if (p && ['fast', 'balanced', 'sharp'].includes(p.quality)) cfg.quality = p.quality;
  if (p && typeof p.audio === 'boolean') cfg.audio = p.audio;
  if (p && typeof p.control === 'boolean') {
    cfg.control = p.control;
    if (!p.control) releaseInput();
  }
  saveCfg();
  return { quality: cfg.quality, audio: cfg.audio, control: cfg.control };
});

ipcMain.handle('sources', async () => {
  const list = await listSources(true);
  if (!list.some((s) => s.id === selectedSourceId)) {
    const first = list.find((s) => s.kind === 'screen') || list[0];
    selectedSourceId = first ? first.id : null;
  }
  return { list: list.map(({ _src, ...s }) => s), selected: selectedSourceId };
});
ipcMain.handle('source:set', (_e, id) => {
  selectedSourceId = String(id);
});

// Ulashishni so'rash: qabul qilinsa {ok:true}, aks holda sababi bilan.
ipcMain.handle('share:request', async (_e, { peerId, source }) => {
  if (out) return { ok: false, error: 'Ulashish allaqachon ketmoqda' };
  const peer = discovery && discovery.get(peerId);
  if (!peer) return { ok: false, error: 'Qurilma topilmadi' };
  let line;
  try {
    line = await signal.connect(discovery.addressesOf(peerId), peer.port);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  out = { line, peer };
  line.send({ t: 'hello', v: 1, from: cfg.name, fromId: cfg.id, source: String(source || '') });
  try {
    const ans = await line.next(['accept', 'reject'], 120000);
    if (ans.t !== 'accept') throw Object.assign(new Error(`${peer.name} rad etdi`), { rejected: true });
  } catch (e) {
    out = null;
    line.close();
    return { ok: false, error: e.message, rejected: !!e.rejected };
  }
  line.on('message', (m) => {
    if (m.t === 'bye') return endOut('peer');
    send('share:signal', m);
  });
  line.on('close', () => endOut('closed'));
  return { ok: true, peer: peer.name };
});

function endOut(reason) {
  if (!out) return;
  const o = out;
  out = null;
  releaseInput();
  o.line.send({ t: 'bye' });
  o.line.close();
  send('share:ended', { reason, peer: o.peer.name });
}

ipcMain.handle('share:signal', (_e, m) => out && out.line.send(m));
ipcMain.handle('share:stop', () => endOut('local'));
ipcMain.handle('share:answer', (_e, { sid, accept, trust, fromId }) => {
  const resolve = pendingAsks.get(sid);
  pendingAsks.delete(sid);
  if (accept && trust && fromId && !cfg.trusted.includes(fromId)) {
    cfg.trusted.push(fromId);
    saveCfg();
  }
  if (resolve) resolve(!!accept);
});

// ---------- IPC: ko'rish oynasi ----------
const viewerOf = (e) => viewers.get(e.sender.id);
ipcMain.handle('viewer:info', (e) => {
  const v = viewerOf(e);
  if (!v) return null;
  // Oyna tinglashga tayyor — navbatdagilarni yuboramiz.
  setImmediate(() => {
    v.ready = true;
    for (const [ch, data] of v.queue.splice(0)) if (!v.win.isDestroyed()) v.win.webContents.send(ch, data);
  });
  return { from: v.from, sid: v.sid };
});
ipcMain.handle('viewer:signal', (e, m) => {
  const v = viewerOf(e);
  if (v) v.line.send(m);
});
ipcMain.handle('viewer:fullscreen', (e, on) => {
  const v = viewerOf(e);
  if (!v) return false;
  v.win.setFullScreen(typeof on === 'boolean' ? on : !v.win.isFullScreen());
  return v.win.isFullScreen();
});
ipcMain.handle('viewer:aspect', (e, ratio) => {
  const v = viewerOf(e);
  if (!v || !(ratio > 0.2 && ratio < 6) || v.win.isFullScreen() || v.sized) return;
  v.sized = true;
  // Oynani videoning nisbatiga moslab, ekranga sig'adigan qilib o'lchaymiz.
  const wa = screen.getDisplayMatching(v.win.getBounds()).workArea;
  let w = Math.min(Math.round(wa.width * 0.82), 1600);
  let h = Math.round(w / ratio);
  if (h > wa.height * 0.85) {
    h = Math.round(wa.height * 0.85);
    w = Math.round(h * ratio);
  }
  v.win.setBounds({ x: Math.round(wa.x + (wa.width - w) / 2), y: Math.round(wa.y + (wa.height - h) / 2), width: w, height: h }, true);
});
ipcMain.handle('viewer:close', (e) => {
  const v = viewerOf(e);
  if (v) v.win.close();
});

// ---------- Avtomatik sinov (test/e2e.js) ----------
function e2eLog(ch, data) {
  if (ch === 'share:signal') return;
  console.log(`[e2e:${E2E}] ${ch} ${JSON.stringify(data).slice(0, 240)}`);
  if (E2E === 'share' && ch === 'peers' && data.length && !e2eLog.started) {
    e2eLog.started = true;
    e2eMotion();
    setTimeout(() => win.webContents.executeJavaScript('__e2e.selectFirstPeer(); __e2e.start()', true).catch((e) => console.log('[e2e] xato', e)), 2500);
    setTimeout(async () => {
      const s = await win.webContents.executeJavaScript('__e2e.stats()').catch(() => null);
      console.log(`[e2e:share] stats ${JSON.stringify(s)}`);
    }, (Number(process.env.UZAT_E2E_SECONDS || 8) + 1) * 1000);
  }
  if (E2E === 'view' && ch === 'share:ask') {
    setTimeout(async () => {
      await e2eShot(win, 'ask');
      win.webContents.executeJavaScript(`document.getElementById('acceptBtn').click()`);
    }, 800);
  }
  if (E2E === 'share' && ch === 'share:ended') setTimeout(() => app.quit(), 500);
}
// DLNA sinovi: qurilma topilishi bilan ulashadi, holat va o'ynatish vaqtini yozib boradi.
function e2eDlna() {
  let started = false;
  const tryStart = async () => {
    if (started || !ssdp || !ssdp.list().length) return;
    started = true;
    const name = process.env.UZAT_E2E_DEVICE || ssdp.list()[0].name;
    const dev = ssdp.list().find((d) => d.name === name);
    console.log(`[e2e:dlna] qurilma ${name} ${dev ? dev.control : 'topilmadi'}`);
    await win.webContents.executeJavaScript(`__e2e.selectByName(${JSON.stringify(name)}) && __e2e.start()`, true);
    const t0 = Date.now();
    const timer = setInterval(async () => {
      const info = await win.webContents.executeJavaScript('__e2e.dlna()').catch(() => ({}));
      const pos = dev ? await dlna.position(dev.control).catch((e) => 'xato:' + e.message) : '';
      console.log(`[e2e:dlna] ${Math.round((Date.now() - t0) / 1000)}s ${JSON.stringify(info)} pos=${pos}`);
    }, 3000);
    setTimeout(async () => {
      clearInterval(timer);
      await e2eShot(win, 'dlna');
      await win.webContents.executeJavaScript('__e2e.stop()').catch(() => {});
      setTimeout(() => app.quit(), 1500);
    }, Number(process.env.UZAT_E2E_SECONDS || 20) * 1000);
  };
  setInterval(tryStart, 1000);
}

// Doimiy harakatlanadigan sinov oynasi — shu ulashiladi.
function e2eMotion() {
  const mw = new BrowserWindow({ width: 960, height: 540, x: 40, y: 40, title: 'E2E harakat', alwaysOnTop: true, webPreferences: { backgroundThrottling: false } });
  mw.setMenu(null);
  mw.loadFile(path.join(__dirname, 'test', 'motion.html'));
}
// Brauzer rejimi sinovi: ulashishni o'zi boshlaydi, manzil va PIN ni chiqaradi, statistikani yozib turadi.
function e2eWeb() {
  if (process.env.UZAT_E2E_CONTROL) cfg.control = true;
  if (!process.env.UZAT_E2E_SCREEN) e2eMotion();
  setTimeout(async () => {
    await win.webContents.executeJavaScript('__e2e.selectWeb(); __e2e.start()', true).catch((e) => console.log('[e2e] xato', e));
    const w = await win.webContents.executeJavaScript('__e2e.web()');
    console.log(`[e2e:web] ready ${JSON.stringify(w)}`);
    const timer = setInterval(async () => {
      const s = await win.webContents.executeJavaScript('__e2e.stats()').catch(() => null);
      console.log(`[e2e:web] stats ${JSON.stringify(s)}`);
    }, 5000);
    setTimeout(async () => {
      clearInterval(timer);
      await e2eShot(win, 'main');
      app.quit();
    }, Number(process.env.UZAT_E2E_SECONDS || 90) * 1000);
  }, 3000);
}
async function e2eShot(w, name) {
  if (!process.env.UZAT_SHOT_DIR || !w || w.isDestroyed()) return;
  const img = await w.webContents.capturePage();
  fs.writeFileSync(path.join(process.env.UZAT_SHOT_DIR, `${E2E}-${name}.png`), img.toPNG());
}
function e2eViewer(vw) {
  setTimeout(async () => {
    await e2eShot(win, 'main');
    const stats = await vw.webContents.executeJavaScript('__e2e.stats()').catch((e) => ({ error: String(e) }));
    console.log(`[e2e:view] stats ${JSON.stringify(stats)}`);
    await e2eShot(vw, 'viewer');
    vw.close();
    setTimeout(() => app.quit(), 800);
  }, Number(process.env.UZAT_E2E_SECONDS || 8) * 1000);
}
ipcMain.on('e2e:shot', (e, name) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (E2E) e2eShot(w, name);
});

// ---------- Hayot sikli ----------
app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.whenReady().then(async () => {
  loadCfg();
  installCaptureHandler();
  createWindow();
  if (E2E === 'web') e2eWeb();
  if (E2E === 'dlna') setTimeout(e2eDlna, 3000);
  try {
    await startNetwork();
  } catch (e) {
    send('net:error', String(e.message || e));
  }
});

app.on('window-all-closed', () => {
  endOut('quit');
  endDlna(false);
  if (ssdp) ssdp.stop();
  releaseInput();
  if (input) input.stop();
  if (web) web.close();
  if (discovery) discovery.stop();
  setTimeout(() => app.quit(), 80);
});
