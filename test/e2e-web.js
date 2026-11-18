'use strict';
// Brauzer rejimi + masofadan boshqarish sinovi:
//  1) Uzat butun ekranni brauzer uchun ulashadi (boshqaruv yoqilgan)
//  2) test/web-client.js sahifani PIN bilan ochadi va video ustida sichqonchani yurgizadi
//  3) kompyuter kursori kutilgan joyga borganini tekshiramiz
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const electron = require('electron');
const { Input } = require('../core/input');

const root = path.join(__dirname, '..');
const shotDir = process.env.SHOT_DIR || '';

(async () => {
  const probe = new Input(path.join(root, 'native', 'input.cs'), path.join(os.tmpdir(), 'uzat-input-test'));
  await probe.start();
  const home = await probe.cursor();

  // UZAT_EXE berilsa — build qilingan ilovani (masalan dist/win-unpacked/Uzat.exe) sinaymiz.
  // Paketlangan ilova --enable-logging siz stdout'ga yozmaydi.
  const uzat = spawn(process.env.UZAT_EXE || electron, process.env.UZAT_EXE ? ['--enable-logging'] : ['.'], {
    cwd: root,
    env: { ...process.env, UZAT_PROFILE: 'e2e-web', UZAT_NAME: 'Hikari-PC', UZAT_E2E: 'web', UZAT_E2E_SCREEN: '1', UZAT_E2E_CONTROL: '1', UZAT_E2E_SECONDS: '40', UZAT_SHOT_DIR: shotDir },
  });
  const ready = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Uzat tayyor bo‘lmadi')), 30000);
    uzat.stdout.on('data', (d) => {
      const m = String(d).match(/\[e2e:web\] ready (.*)/);
      if (m) {
        clearTimeout(t);
        resolve(JSON.parse(m[1]));
      }
    });
  });
  console.log('Uzat tayyor:', ready.urls[0], 'PIN', ready.pin);

  // Uzat yordamchiga yuborgan har bir buyruqni yozib boramiz (haqiqiy kursorga bog'liq emas —
  // foydalanuvchi sinov paytida sichqonchani qimirlatsa ham natija buzilmaydi).
  const inputs = [];
  uzat.stdout.on('data', (d) => {
    for (const m of String(d).matchAll(/\[e2e:input\] (\w+) (-?\d+) (-?\d+)/g)) inputs.push({ t: Date.now(), a: m[1], x: +m[2], y: +m[3] });
  });

  const moves = [];
  const client = spawn(electron, [path.join(__dirname, 'web-client.js'), `http://127.0.0.1:8090/?pin=${ready.pin}`], {
    cwd: root,
    env: { ...process.env, CLIENT_SHOT_DIR: shotDir },
  });
  client.stdout.on('data', (d) => {
    for (const line of String(d).split('\n').filter(Boolean)) {
      console.log(line.trim());
      const m = line.match(/\[client\] move ([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+)/);
      if (m) moves.push({ t: Date.now() - 400, nx: +m[3], ny: +m[4] });
    }
  });
  await new Promise((r) => client.on('exit', r));
  uzat.kill();
  probe.move(home.x, home.y);

  // Butun ekran 1 ta monitor: kutilgan = n * (o'lcham - 1)
  const W = Number(process.env.SCREEN_W || 1920);
  const H = Number(process.env.SCREEN_H || 1080);
  let ok = moves.length === 3;
  for (const mv of moves) {
    const ex = Math.round(mv.nx * (W - 1));
    const ey = Math.round(mv.ny * (H - 1));
    const got = inputs.find((i) => i.t >= mv.t - 200 && Math.abs(i.x - ex) <= 3 && Math.abs(i.y - ey) <= 3);
    const near = got || inputs.filter((i) => i.t >= mv.t - 200)[0];
    console.log(`kutilgan (${ex}, ${ey}) → yordamchiga yuborildi ${near ? `(${near.x}, ${near.y})` : 'hech narsa'}${got ? ' ✓' : ' ✗'}`);
    if (!got) ok = false;
  }
  console.log(`Jami yordamchiga ${inputs.length} ta buyruq yuborildi`);
  probe.stop();
  console.log(ok ? 'E2E-WEB: brauzer orqali boshqaruv ishlayapti' : 'E2E-WEB: XATO');
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
