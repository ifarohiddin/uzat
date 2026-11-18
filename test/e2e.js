'use strict';
// Bir kompyuterda ikkita Uzat nusxasini ochadi: biri ekranini ulashadi, ikkinchisi so'rovni qabul qilib ko'radi.
// Ko'rish oynasidagi WebRTC statistikasi (o'lcham, fps, dekodlangan kadrlar) tekshiriladi.
const { spawn } = require('child_process');
const path = require('path');
const electron = require('electron');

const shotDir = process.env.SHOT_DIR || '';
const seconds = Number(process.env.SECONDS_LIVE || 8);
let stats = null;

const run = (name, env) =>
  new Promise((resolve) => {
    const p = spawn(electron, ['.'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, UZAT_PROFILE: 'e2e-' + name, UZAT_NAME: name, UZAT_SHOT_DIR: shotDir, ...env },
    });
    const log = (d) =>
      String(d)
        .split('\n')
        .filter((l) => l.includes('[e2e'))
        .forEach((l) => {
          console.log(l.trim().slice(0, 260));
          const m = l.match(/\[e2e:view\] stats (.*)$/);
          if (m) stats = JSON.parse(m[1]);
        });
    p.stdout.on('data', log);
    p.stderr.on('data', log);
    const kill = setTimeout(() => p.kill(), (seconds + 60) * 1000);
    p.on('exit', (code) => {
      clearTimeout(kill);
      resolve(code);
    });
  });

(async () => {
  const viewer = run('Artur', { UZAT_E2E: 'view', UZAT_E2E_SECONDS: String(seconds) });
  await new Promise((r) => setTimeout(r, 1500));
  const sharer = run('Hikari-PC', { UZAT_E2E: 'share' });
  await Promise.all([viewer, sharer]);

  const ok = stats && stats.connection === 'connected' && stats.videoWidth > 0 && stats.decoded > 30;
  console.log(
    ok
      ? `E2E: ekran keldi — ${stats.w}×${stats.h}, ${Math.round(stats.fps || 0)} fps, ${stats.decoded} kadr, kodek ${stats.codec}, bufer ${Math.round(stats.buffer || 0)} ms`
      : `E2E: XATO — ${JSON.stringify(stats)}`
  );
  process.exit(ok ? 0 : 1);
})();
