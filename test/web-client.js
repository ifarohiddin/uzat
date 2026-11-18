'use strict';
// "Android qurilma" o'rnida: brauzer sahifasini PIN bilan ochadi, video kelishini kutadi,
// so'ng video ustida sichqonchani yurgizadi (bosmaydi). Natijani stdout'ga yozadi.
// Ishga tushirish: electron test/web-client.js <url> <shotDir>
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

// Diqqat: Electron oxirgi argumentdagi papka yo'lini o'zicha tushunib yopilib qoladi, shuning uchun papka — muhit o'zgaruvchisida.
const url = process.argv.find((a) => /^https?:\/\//.test(a));
const shotDir = process.env.CLIENT_SHOT_DIR || '';
const W = 800;
const H = 450;

app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: W, height: H, useContentSize: true, x: 900, y: 500, show: true, title: 'Android sinov', webPreferences: { backgroundThrottling: false } });
  await win.loadURL(url);
  const js = (code) => win.webContents.executeJavaScript(code);
  const t0 = Date.now();
  let st;
  while (Date.now() - t0 < 20000) {
    st = await js(`({ w: video.videoWidth, h: video.videoHeight, control: document.body.classList.contains('control'), title: document.getElementById('title').textContent })`);
    if (st.w && st.control) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log('[client] holat', JSON.stringify(st));
  await new Promise((r) => setTimeout(r, 1500));
  if (shotDir) fs.writeFileSync(path.join(shotDir, 'client.png'), (await win.webContents.capturePage()).toPNG());

  // Videoning o'zi qayerda ekanini (qora chetlarsiz) aniqlaymiz.
  const box = await js(`(() => { const r = video.getBoundingClientRect(); const s = Math.min(r.width / video.videoWidth, r.height / video.videoHeight);
    const w = video.videoWidth * s, h = video.videoHeight * s; return { x0: r.left + (r.width - w) / 2, y0: r.top + (r.height - h) / 2, w, h }; })()`);
  // Nuqtalar sinov oynasining o'zidan uzoqda (o'ng pastda), aks holda kursor oyna ustiga tushib, aylanma hodisa beradi.
  for (const [nx, ny] of [
    [0.1, 0.1],
    [0.3, 0.2],
    [0.45, 0.4],
  ]) {
    const x = Math.round(box.x0 + nx * box.w);
    const y = Math.round(box.y0 + ny * box.h);
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    await new Promise((r) => setTimeout(r, 400));
    console.log(`[client] move ${nx} ${ny} ${(x - box.x0) / box.w} ${(y - box.y0) / box.h}`);
    // Test haydovchisi shu paytda kursor joyini o'lchaydi
    await new Promise((r) => setTimeout(r, 600));
  }
  app.quit();
});
