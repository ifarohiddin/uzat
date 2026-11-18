'use strict';
// Lokal tarmoqda Uzat ishlayotgan kompyuterlarni UDP broadcast orqali topish.
const dgram = require('dgram');
const os = require('os');
const { EventEmitter } = require('events');

const DISCOVERY_PORT = 47321;
const ANNOUNCE_MS = 2000;
const EXPIRE_MS = 7000;

function broadcastAddresses() {
  const out = new Set(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family !== 'IPv4' || ni.internal || !ni.netmask) continue;
      const a = ni.address.split('.').map(Number);
      const m = ni.netmask.split('.').map(Number);
      out.add(a.map((b, i) => (b | (~m[i] & 255)) & 255).join('.'));
    }
  }
  return [...out];
}

class Discovery extends EventEmitter {
  constructor(self, port = DISCOVERY_PORT) {
    super();
    this.self = self; // { id, name, port }
    this.port = port;
    this.peers = new Map();
  }

  start() {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.sock = sock;
    sock.on('error', (e) => this.emit('error', e));
    sock.on('message', (buf, rinfo) => this._onMessage(buf, rinfo));
    sock.bind(this.port, () => {
      sock.setBroadcast(true);
      this._send('hello');
    });
    this.timer = setInterval(() => {
      this._send('here');
      this._prune();
    }, ANNOUNCE_MS);
  }

  setName(name) {
    this.self.name = name;
    this._send('here');
  }

  list() {
    return [...this.peers.values()]
      .map(({ id, name, address, port }) => ({ id, name, address, port }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id) {
    return this.peers.get(id);
  }

  // Ulanish uchun manzillar: avval joriy, keyin qolganlari (eng yangisi birinchi).
  addressesOf(id) {
    const p = this.peers.get(id);
    if (!p) return [];
    const rest = [...p.addrs.entries()].filter(([a]) => a !== p.address).sort((x, y) => y[1] - x[1]).map(([a]) => a);
    return [p.address, ...rest];
  }

  stop() {
    clearInterval(this.timer);
    if (!this.sock) return;
    try {
      this._send('bye');
    } catch {}
    const s = this.sock;
    this.sock = null;
    setTimeout(() => s.close(), 50);
  }

  _payload(t) {
    return Buffer.from(
      JSON.stringify({ app: 'uzat', v: 1, t, id: this.self.id, name: this.self.name, port: this.self.port })
    );
  }

  _send(t, address) {
    if (!this.sock) return;
    const msg = this._payload(t);
    const targets = address ? [address] : broadcastAddresses();
    for (const addr of targets) this.sock.send(msg, this.port, addr, () => {});
  }

  _onMessage(buf, rinfo) {
    if (buf.length > 2048) return;
    let m;
    try {
      m = JSON.parse(buf.toString('utf8'));
    } catch {
      return;
    }
    if (!m || m.app !== 'uzat' || typeof m.id !== 'string' || m.id === this.self.id) return;

    if (m.t === 'bye') {
      if (this.peers.delete(m.id)) this.emit('change', this.list());
      return;
    }
    const port = Number(m.port) | 0;
    if (port <= 0 || port > 65535) return;

    // Kompyuterda bir nechta tarmoq adapteri bo'lsa, bitta qurilma bir nechta manzildan ko'rinadi.
    // Joriy manzil hali "tirik" ekan, uni almashtirmaymiz — aks holda ro'yxat miltillab turadi.
    const now = Date.now();
    const id = m.id.slice(0, 64);
    const prev = this.peers.get(id);
    const addrs = prev ? prev.addrs : new Map();
    addrs.set(rinfo.address, now);
    for (const [a, t] of addrs) if (now - t > EXPIRE_MS) addrs.delete(a);
    let address = prev && addrs.has(prev.address) ? prev.address : rinfo.address;
    const peer = { id, name: String(m.name || 'Kompyuter').slice(0, 40), address, port, seen: now, addrs };
    this.peers.set(id, peer);
    if (!prev || prev.name !== peer.name || prev.address !== peer.address || prev.port !== peer.port) {
      this.emit('change', this.list());
    }
    // Yangi qo'shilgan qurilmaga darhol javob beramiz, u bizni 2 soniya kutmasin.
    if (m.t === 'hello') this._send('here', rinfo.address);
  }

  _prune() {
    const now = Date.now();
    let changed = false;
    for (const [id, p] of this.peers) {
      if (now - p.seen > EXPIRE_MS) {
        this.peers.delete(id);
        changed = true;
      }
    }
    if (changed) this.emit('change', this.list());
  }
}

module.exports = { Discovery, DISCOVERY_PORT };
