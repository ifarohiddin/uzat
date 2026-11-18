'use strict';
// WebRTC signal kanali: ikki kompyuter orasida qatorlab JSON xabar almashadigan oddiy TCP ulanish.
// Videoning o'zi bu kanaldan o'tmaydi — u WebRTC orqali to'g'ridan-to'g'ri ketadi.
const net = require('net');
const { EventEmitter } = require('events');

const MAX_LINE = 1024 * 1024;

class Line extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.closed = false;
    this.remoteAddress = socket.remoteAddress;
    let buf = '';
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 5000);
    socket.setEncoding('utf8');
    socket.on('data', (d) => {
      buf += d;
      if (buf.length > MAX_LINE) return socket.destroy();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg && typeof msg.t === 'string') this.emit('message', msg);
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      if (this.closed) return;
      this.closed = true;
      this.emit('close');
    });
  }

  send(obj) {
    if (this.closed || this.socket.destroyed) return;
    this.socket.write(JSON.stringify(obj) + '\n');
  }

  // Bitta xabarni kutish (masalan, 'accept' yoki 'reject').
  next(types, ms) {
    return new Promise((resolve, reject) => {
      const done = (fn, v) => {
        clearTimeout(timer);
        this.off('message', onMsg);
        this.off('close', onClose);
        fn(v);
      };
      const onMsg = (m) => types.includes(m.t) && done(resolve, m);
      const onClose = () => done(reject, new Error('Aloqa uzildi'));
      const timer = setTimeout(() => done(reject, new Error('Javob kelmadi')), ms);
      this.on('message', onMsg);
      this.on('close', onClose);
    });
  }

  close() {
    if (this.socket.destroyed) return;
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 500).unref();
  }
}

function listen(onLine, port = 0) {
  const server = net.createServer((s) => onLine(new Line(s)));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      server.off('error', reject);
      resolve({ server, port: server.address().port });
    });
  });
}

// Bir nechta manzildan birinchi ulanganini oladi (kompyuterda bir nechta tarmoq adapteri bo'lishi mumkin).
async function connect(addresses, port, timeoutMs = 4000) {
  let lastErr = new Error("Qurilmaga ulanib bo'lmadi");
  for (const host of addresses) {
    try {
      const s = await new Promise((resolve, reject) => {
        const s = net.connect({ host, port });
        const t = setTimeout(() => {
          s.destroy();
          reject(new Error('Ulanish vaqti tugadi'));
        }, timeoutMs);
        s.once('connect', () => {
          clearTimeout(t);
          s.removeAllListeners('error');
          resolve(s);
        });
        s.once('error', (e) => {
          clearTimeout(t);
          reject(e);
        });
      });
      return new Line(s);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

module.exports = { listen, connect, Line };
