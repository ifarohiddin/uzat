'use strict';
// Tarmoqdagi DLNA "Media Renderer" qurilmalarni (Android head unit, televizor va h.k.) SSDP orqali topish.
const dgram = require('dgram');
const http = require('http');
const os = require('os');
const { EventEmitter } = require('events');

const MCAST = '239.255.255.250';
const ST = 'urn:schemas-upnp-org:device:MediaRenderer:1';
const SEARCH_MS = 8000;
const EXPIRE_MS = 30000;

function localIPv4() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) if (ni.family === 'IPv4' && !ni.internal && !ni.address.startsWith('169.254.')) out.push(ni.address);
  }
  return out;
}

function fetchText(url, ms = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: ms }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        d += c;
        if (d.length > 512 * 1024) req.destroy();
      });
      res.on('end', () => resolve(d));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<(?:\\w+:)?${name}>([^<]*)</(?:\\w+:)?${name}>`, 'i'));
  return m ? m[1].trim() : '';
};

function parseDescription(xml, location) {
  const name = tag(xml, 'friendlyName') || 'DLNA qurilma';
  let control = '';
  const services = xml.split(/<service>/i).slice(1);
  for (const s of services) {
    if (/AVTransport/i.test(tag(s, 'serviceType'))) control = tag(s, 'controlURL');
  }
  if (!control) return null;
  const base = tag(xml, 'URLBase') || location;
  return { name: name.slice(0, 40), control: new URL(control, base).toString(), model: tag(xml, 'modelName') };
}

class SSDP extends EventEmitter {
  constructor() {
    super();
    this.devices = new Map(); // uuid -> { id, name, address, control, seen }
    this.socks = [];
    this.pending = new Set();
  }

  start() {
    // Har bir tarmoq adapteridan alohida qidiramiz (masalan, Windows hotspot 192.168.137.1).
    for (const addr of localIPv4()) {
      const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      s.on('error', () => {});
      s.on('message', (m, r) => this._onMessage(String(m), r));
      s.bind(0, addr, () => {
        try {
          s.setMulticastInterface(addr);
        } catch {}
        this._search(s);
      });
      this.socks.push(s);
    }
    this.timer = setInterval(() => {
      for (const s of this.socks) this._search(s);
      this._prune();
    }, SEARCH_MS);
  }

  stop() {
    clearInterval(this.timer);
    for (const s of this.socks) s.close();
    this.socks = [];
  }

  list() {
    return [...this.devices.values()].map(({ id, name, address, control }) => ({ id, name, address, control, kind: 'dlna' }));
  }

  get(id) {
    return this.devices.get(id.replace(/^dlna:/, ''));
  }

  _search(s) {
    const q = `M-SEARCH * HTTP/1.1\r\nHOST: ${MCAST}:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${ST}\r\n\r\n`;
    try {
      s.send(q, 1900, MCAST);
    } catch {}
  }

  async _onMessage(msg, rinfo) {
    if (!/^HTTP\/1\.1 200/i.test(msg)) return;
    const h = {};
    for (const line of msg.split('\r\n')) {
      const i = line.indexOf(':');
      if (i > 0) h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    if (!/MediaRenderer/i.test(h.st || '') || !h.location) return;
    const uuid = ((h.usn || '').match(/uuid:([^:]+)/) || [])[1] || h.location;
    const known = this.devices.get(uuid);
    if (known) {
      known.seen = Date.now();
      return;
    }
    if (this.pending.has(uuid)) return;
    this.pending.add(uuid);
    try {
      const desc = parseDescription(await fetchText(h.location), h.location);
      if (desc) {
        this.devices.set(uuid, { id: `dlna:${uuid}`, address: rinfo.address, seen: Date.now(), ...desc });
        this.emit('change', this.list());
      }
    } catch {
    } finally {
      this.pending.delete(uuid);
    }
  }

  _prune() {
    const now = Date.now();
    let changed = false;
    for (const [k, d] of this.devices) {
      if (now - d.seen > EXPIRE_MS) {
        this.devices.delete(k);
        changed = true;
      }
    }
    if (changed) this.emit('change', this.list());
  }
}

module.exports = { SSDP };
