'use strict';
// build/icon.svg dan build/icon.png (512×512) yasaydi. Ishga tushirish: npx electron build/make-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.disableHardwareAcceleration();
app.whenReady().then(() => {
  const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8');
  const html = `<html><body style="margin:0;background:transparent">${svg}</body></html>`;
  const win = new BrowserWindow({ show: false, width: 512, height: 512, transparent: true, frame: false, webPreferences: { offscreen: true } });
  win.webContents.setFrameRate(5);
  let done = false;
  win.webContents.on('paint', (_e, _dirty, image) => {
    if (done) return;
    const size = image.getSize();
    if (size.width < 512) return;
    done = true;
    fs.writeFileSync(path.join(__dirname, 'icon.png'), image.resize({ width: 512, height: 512 }).toPNG());
    console.log('icon.png', size);
    app.quit();
  });
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  setTimeout(() => app.quit(), 10000);
});
