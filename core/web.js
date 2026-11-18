'use strict';
// Brauzer orqali ko'rish: Android, televizor yoki boshqa qurilma hech narsa o'rnatmasdan
// http://<kompyuter-ip>:8090 sahifasini ochib, ekranni WebRTC orqali jonli ko'radi.
// Signal: server -> brauzer SSE (EventSource), brauzer -> server POST.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const FILES = {
  '/': ['web/index.html', 'text/html; charset=utf-8'],
  '/web.css': ['web/web.css', 'text/css; charset=utf-8'],
  '/web.js': ['web/web.js', 'text/javascript; charset=utf-8'],
  '/rtc.js': ['src/rtc.js', 'text/javascript; charset=utf-8'],
};
const MAX_BODY = 256 * 1024;

// Ko'rsatish uchun manzillar: Windows hotspot (192.168.137.x) va uy tarmoqlari birinchi.
function lanAddresses() {
  const out = [];
  for (const [ifname, list] of Object.entries(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      const a = ni.address;
      if (a.startsWith('169.254.')) continue;
      const [x, y] = a.split('.').map(Number);
      if (x === 100 && y >= 64 && y <= 127) continue; // Tailscale / CGNAT
      let rank = 5;
      if (a.startsWith('192.168.137.')) rank = 0;
      else if (a.startsWith('192.168.')) rank = 1;
      else if (x === 10) rank = 2;
      else if (x === 172 && y >= 16 && y <= 31) rank = 3;
      if (/vEthernet|VirtualBox|VMware|WSL|Hyper-V/i.test(ifname)) rank += 10;
      out.push({ address: a, rank });
    }
  }
  return out.sort((p, q) => p.rank - q.rank).map((p) => p.address);
}

function deviceName(ua) {
  ua = String(ua || '');
  const m = ua.match(/Android [\d.]+; ([^;)]+?)(?: Build|\))/);
  if (m && m[1] && !/^(K|wv)$/.test(m[1].trim())) return m[1].trim().slice(0, 40);
  if (/Android/.test(ua)) return 'Android';
  if (/iPhone|iPad/.test(ua)) return 'iPhone/iPad';
  if (/Windows/.test(ua)) return 'Windows brauzer';
  if (/Mac OS/.test(ua)) return 'Mac brauzer';
  return 'Brauzer';
}

class WebShare extends EventEmitter {
  constructor(root) {
    super();
    this.root = root;
    this.pin = null; // null = hozir ulashish yo'q
    this.from = 'Kompyuter';
    this.viewers = new Map(); // vid -> { res, name, addr }
    this.live = null; // DLNA oqimi: { token, mime }
    this.streams = new Map(); // rid -> res
    this.server = http.createServer((req, res) => this._route(req, res).catch(() => this._json(res, 500, { error: 'Server xatosi' })));
    this.server.keepAliveTimeout = 30000;
  }

  async listen(preferred = 8090) {
    for (let port = preferred; port < preferred + 20; port++) {
      try {
        await new Promise((resolve, reject) => {
          this.server.once('error', reject);
          this.server.listen(port, '0.0.0.0', () => {
            this.server.off('error', reject);
            resolve();
          });
        });
        this.port = port;
        return port;
      } catch (e) {
        if (e.code !== 'EADDRINUSE') throw e;
      }
    }
    throw new Error("Veb-server uchun bo'sh port topilmadi");
  }

  urls() {
    return lanAddresses().map((a) => `http://${a}${this.port === 80 ? '' : ':' + this.port}`);
  }

  // Ulashish boshlanadi: yangi PIN.
  open(from) {
    this.from = from;
    this.pin = String(crypto.randomInt(1000, 10000));
    return this.pin;
  }

  // Ulashish tugadi: hamma ko'ruvchilarga xabar berib, uzamiz.
  close() {
    this.pin = null;
    for (const vid of [...this.viewers.keys()]) this.drop(vid, 'bye');
  }

  // ---- DLNA jonli oqim ----
  openLive(mime) {
    this.closeLive();
    this.live = { token: crypto.randomBytes(9).toString('base64url'), mime };
    return this.live.token;
  }
  closeLive() {
    this.live = null;
    for (const res of this.streams.values()) res.destroy();
    this.streams.clear();
  }
  // Yuborish navbati to'lib ketsa (qurilma sekin o'qisa) — false qaytaradi.
  writeLive(rid, buf) {
    const res = this.streams.get(rid);
    if (!res) return false;
    return res.write(buf);
  }
  // Mos lokal IP: qurilma bilan bir xil tarmoqdagi manzil.
  addressFor(remote) {
    const pre = String(remote).split('.').slice(0, 3).join('.') + '.';
    return lanAddresses().find((a) => a.startsWith(pre)) || lanAddresses()[0];
  }

  send(vid, msg) {
    const v = this.viewers.get(vid);
    if (v) v.res.write(`data: ${JSON.stringify(msg)}\n\n`);
  }

  drop(vid, t = 'bye') {
    const v = this.viewers.get(vid);
    if (!v) return;
    this.viewers.delete(vid);
    try {
      v.res.write(`data: ${JSON.stringify({ t })}\n\n`);
      v.res.end();
    } catch {}
    this.emit('leave', { vid });
  }

  _json(res, code, obj) {
    if (res.headersSent) return;
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  }

  _body(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new Error('katta'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
        } catch (e) {
          reject(e);
        }
      });
      req.on('error', reject);
    });
  }

  async _route(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (req.method === 'GET' && FILES[p]) {
      const [file, type] = FILES[p];
      const data = await fs.promises.readFile(path.join(this.root, file));
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      return res.end(data);
    }

    // DLNA qurilma uchun jonli video oqimi: /live/<token>.<ext>
    const lv = p.match(/^\/live\/([\w-]+)\.(\w+)$/);
    if (lv && (req.method === 'GET' || req.method === 'HEAD')) {
      if (!this.live || lv[1] !== this.live.token) return this._json(res, 404, { error: "Oqim yo'q" });
      // Chunked kodlashsiz, ulanish yopilguncha uzluksiz — DLNA pleyerlar shuni yaxshi tushunadi.
      res.useChunkedEncodingByDefault = false;
      res.writeHead(200, {
        'Content-Type': this.live.mime,
        'Cache-Control': 'no-cache',
        Connection: 'close',
        'transferMode.dlna.org': 'Streaming',
        'contentFeatures.dlna.org': 'DLNA.ORG_OP=00;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000',
      });
      if (req.method === 'HEAD') return res.end();
      req.socket.setNoDelay(true);
      req.socket.setTimeout(0);
      const rid = crypto.randomUUID();
      this.streams.set(rid, res);
      req.on('close', () => {
        this.streams.delete(rid);
        this.emit('live:close', { rid });
      });
      this.emit('live:open', { rid, address: req.socket.remoteAddress });
      return;
    }

    if (req.method === 'GET' && p === '/api/status') {
      return this._json(res, 200, { sharing: !!this.pin, from: this.from });
    }

    if (req.method === 'POST' && p === '/api/join') {
      const body = await this._body(req);
      if (!this.pin) return this._json(res, 409, { error: 'waiting', from: this.from });
      if (String(body.pin || '') !== this.pin) return this._json(res, 403, { error: "PIN noto'g'ri" });
      const vid = crypto.randomUUID();
      const name = deviceName(req.headers['user-agent']);
      // SSE ulanishi kelguncha joy band qilib turamiz.
      this.viewers.set(vid, { res: null, name, addr: req.socket.remoteAddress, pending: true });
      setTimeout(() => {
        const v = this.viewers.get(vid);
        if (v && v.pending) this.viewers.delete(vid);
      }, 15000).unref();
      return this._json(res, 200, { vid, from: this.from, name });
    }

    if (req.method === 'GET' && p === '/api/events') {
      const vid = url.searchParams.get('vid');
      const v = this.viewers.get(vid);
      if (!v || !v.pending) return this._json(res, 404, { error: "Sessiya yo'q" });
      v.pending = false;
      v.res = res;
      req.socket.setNoDelay(true);
      req.socket.setTimeout(0);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': ok\n\n');
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => {
        clearInterval(ping);
        if (this.viewers.get(vid) === v) {
          this.viewers.delete(vid);
          this.emit('leave', { vid });
        }
      });
      this.emit('join', { vid, name: v.name, address: v.addr });
      return;
    }

    if (req.method === 'POST' && p === '/api/signal') {
      const body = await this._body(req);
      const v = this.viewers.get(body.vid);
      if (!v || v.pending || !body.m || typeof body.m.t !== 'string') return this._json(res, 404, { error: "Sessiya yo'q" });
      if (body.m.t === 'bye') this.drop(body.vid, 'closed');
      else this.emit('signal', { vid: body.vid, m: body.m });
      return this._json(res, 200, { ok: true });
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Topilmadi');
  }
}

module.exports = { WebShare, lanAddresses };
