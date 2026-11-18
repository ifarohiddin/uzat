'use strict';
// Masofadan boshqaruv: native/input.cs yordamchisini (bir marta kompilyatsiya qilinadi) ishga tushirib,
// unga sichqoncha/klaviatura buyruqlarini yuboradi.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const CSC = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

// app.asar ichidagi faylni tashqi dastur o'qiy olmaydi — "unpacked" nusxasiga yo'naltiramiz.
const unpacked = (p) => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');

class Input {
  // prebuilt: build paytida tayyorlangan uzat-input.exe (bo'lsa, kompilyatsiya qilinmaydi)
  constructor(src, outDir, prebuilt) {
    this.src = unpacked(path.resolve(src)); // csc nisbiy yo'ldagi "/" ni parametr deb tushunadi
    this.exe = path.join(outDir, 'uzat-input.exe');
    if (prebuilt && fs.existsSync(unpacked(prebuilt))) {
      this.exe = unpacked(prebuilt);
      this.ready = true;
    }
    this.proc = null;
    this.starting = null;
    this.waiters = [];
  }

  async _build() {
    if (this.ready) return;
    const srcTime = fs.statSync(this.src).mtimeMs;
    if (fs.existsSync(this.exe) && fs.statSync(this.exe).mtimeMs >= srcTime) return;
    fs.mkdirSync(path.dirname(this.exe), { recursive: true });
    await new Promise((resolve, reject) =>
      execFile(CSC, ['/nologo', '/optimize+', '/target:exe', '/platform:anycpu', `/out:${this.exe}`, this.src], { windowsHide: true }, (err, out) =>
        err ? reject(new Error(`Yordamchini kompilyatsiya qilib bo'lmadi: ${out || err.message}`)) : resolve()
      )
    );
  }

  start() {
    if (this.proc) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = (async () => {
      if (process.platform !== 'win32') throw new Error('Boshqaruv faqat Windows’da ishlaydi');
      await this._build();
      const proc = spawn(this.exe, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      let buf = '';
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('Yordamchi javob bermadi')), 5000);
        proc.stdout.setEncoding('utf8');
        proc.stdout.on('data', (d) => {
          buf += d;
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (line === 'ready') {
              clearTimeout(t);
              resolve();
            } else {
              const w = this.waiters.shift();
              if (w) w(line);
            }
          }
        });
        proc.once('error', reject);
      });
      proc.on('exit', () => {
        if (this.proc === proc) this.proc = null;
      });
      proc.stdin.on('error', () => {});
      this.proc = proc;
    })().finally(() => (this.starting = null));
    return this.starting;
  }

  cmd(line) {
    if (this.proc) this.proc.stdin.write(line + '\n');
  }

  query(line) {
    return new Promise((resolve) => {
      if (!this.proc) return resolve(null);
      this.waiters.push(resolve);
      this.cmd(line);
    });
  }

  move(x, y) {
    this.cmd(`m ${Math.round(x)} ${Math.round(y)}`);
  }
  down(b = 'l') {
    this.cmd(`d ${b}`);
  }
  up(b = 'l') {
    this.cmd(`u ${b}`);
  }
  wheel(dy, dx) {
    if (dy) this.cmd(`w ${Math.round(dy)}`);
    if (dx) this.cmd(`h ${Math.round(dx)}`);
  }
  text(s) {
    if (s) this.cmd(`t ${Buffer.from(String(s), 'utf8').toString('base64')}`);
  }
  key(vk) {
    this.cmd(`k ${vk | 0}`);
  }
  async cursor() {
    const r = await this.query('c');
    const m = r && r.match(/^c (-?\d+) (-?\d+)$/);
    return m ? { x: +m[1], y: +m[2] } : null;
  }

  stop() {
    if (this.proc) {
      this.cmd('q');
      this.proc = null;
    }
  }
}

module.exports = { Input };
