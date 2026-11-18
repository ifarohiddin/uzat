'use strict';
// Brauzerdagi ko'ruvchi. Eski Android WebView'lar uchun ham ishlashi uchun oddiy JS ishlatilgan.
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var video = $('video');
  var pinInput = $('pin');
  var pc = null, es = null, vid = null, ice = null, statsTimer = null, retryTimer = null, from = 'Kompyuter';
  var connected = false;
  var dc = null, control = false;

  function setControl(on) {
    control = on;
    document.body.classList.toggle('control', on);
    $('kbBtn').hidden = !on;
    if (!on) $('kb').hidden = true;
    $('tap').textContent = on ? 'Boshqaruv yoqilgan · ⛶ — to‘liq ekran' : "Ekranga bosing — to'liq ekran";
  }
  function sendInput(m) {
    if (control && dc && dc.readyState === 'open') dc.send(JSON.stringify(m));
  }

  function store(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
  function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

  function panel(title, msg, opts) {
    opts = opts || {};
    $('panel').classList.remove('gone');
    $('hud').hidden = true;
    $('tap').hidden = true;
    $('title').textContent = title;
    $('msg').textContent = msg || '';
    $('msg').className = 'msg' + (opts.err ? ' err' : '');
    $('spinner').hidden = !opts.spin;
    $('pinForm').hidden = !!opts.hideForm;
    $('sub').hidden = !!opts.hideForm;
  }

  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { j.status = r.status; return j; }); });
  }

  function cleanup() {
    connected = false;
    dc = null;
    setControl(false);
    clearInterval(statsTimer);
    if (es) { es.close(); es = null; }
    if (pc) { pc.close(); pc = null; }
    video.srcObject = null;
    vid = null;
  }

  function retry(pin, ms) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(function () { join(pin); }, ms);
  }

  function join(pin) {
    clearTimeout(retryTimer);
    if (!/^\d{4}$/.test(pin)) {
      panel("Ekranni ko'rish", '4 xonali PIN kiriting', { err: true });
      return;
    }
    post('/api/join', { pin: pin })
      .then(function (r) {
        if (r.status === 409) {
          from = r.from || from;
          panel(from + ' kutilmoqda', 'Kompyuterda «Ulashish» bosilishi bilan ekran shu yerda ochiladi.', { spin: true, hideForm: true });
          return retry(pin, 2000);
        }
        if (r.status === 403) {
          store('uzat-pin', null);
          panel("Ekranni ko'rish", "PIN noto'g'ri. Kompyuterdagi Uzat oynasiga qarang.", { err: true });
          pinInput.value = '';
          pinInput.focus();
          return;
        }
        if (!r.vid) throw new Error(r.error || 'Xato');
        store('uzat-pin', pin);
        from = r.from;
        start(r.vid, pin);
      })
      .catch(function () {
        panel('Kompyuter topilmadi', "Uzat yopiq yoki tarmoq uzilgan. Qayta urinilmoqda…", { spin: true, hideForm: true });
        retry(pin, 3000);
      });
  }

  function send(m) {
    if (vid) post('/api/signal', { vid: vid, m: m }).catch(function () {});
  }

  function start(id, pin) {
    cleanup();
    vid = id;
    panel(from + ' ekraniga ulanmoqda…', '', { spin: true, hideForm: true });

    pc = new RTCPeerConnection(RTC.config);
    ice = RTC.iceQueue(pc);
    pc.ontrack = function (e) {
      var ms = (e.streams && e.streams[0]) || new MediaStream([e.track]);
      if (video.srcObject !== ms) video.srcObject = ms;
      if (e.track.kind === 'audio') $('soundBtn').hidden = !video.muted;
      var p = video.play();
      if (p && p.catch) p.catch(function () {});
    };
    pc.ondatachannel = function (e) {
      if (e.channel.label !== 'input') return;
      dc = e.channel;
      dc.onmessage = function (ev) {
        var m;
        try { m = JSON.parse(ev.data); } catch (x) { return; }
        if (m.t === 'cfg') setControl(!!m.control);
      };
      dc.onclose = function () { dc = null; setControl(false); };
    };
    pc.onicecandidate = function (e) { if (e.candidate) send({ t: 'ice', c: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate }); };
    pc.onconnectionstatechange = function () {
      if (pc && pc.connectionState === 'failed') { cleanup(); panel('Ulanish uzildi', 'Qayta ulanmoqda…', { spin: true, hideForm: true }); retry(pin, 1500); }
    };

    es = new EventSource('/api/events?vid=' + encodeURIComponent(id));
    es.onmessage = function (ev) {
      var m;
      try { m = JSON.parse(ev.data); } catch (x) { return; }
      if (m.t === 'sdp' && m.sdp && m.sdp.type === 'offer') {
        pc.setRemoteDescription(m.sdp)
          .then(function () { return ice.flush(); })
          .then(function () { return pc.createAnswer(); })
          .then(function (a) { return pc.setLocalDescription(a); })
          .then(function () { send({ t: 'sdp', sdp: pc.localDescription.toJSON ? pc.localDescription.toJSON() : { type: 'answer', sdp: pc.localDescription.sdp } }); })
          .catch(function (err) { panel('Xato', String(err && err.message), { err: true }); });
      } else if (m.t === 'ice' && m.c) {
        ice.add(m.c);
      } else if (m.t === 'bye' || m.t === 'closed') {
        cleanup();
        panel(from + ' kutilmoqda', 'Ulashish to‘xtatildi. Qayta boshlansa, ekran o‘zi ochiladi.', { spin: true, hideForm: true });
        retry(pin, 2000);
      }
    };
    es.onerror = function () {
      // Server ulanishni yopdi yoki tarmoq uzildi — o'zimiz qayta ulanamiz.
      if (!es) return;
      cleanup();
      panel('Aloqa uzildi', 'Qayta ulanmoqda…', { spin: true, hideForm: true });
      retry(pin, 2000);
    };

    var read = RTC.statsReader(pc, 'in');
    statsTimer = setInterval(function () {
      if (!pc) return;
      read().then(function (s) {
        if (!s.w) return;
        var parts = [RTC.fmtStats(s)];
        if (s.buffer != null) parts.push('bufer ' + Math.round(s.buffer) + ' ms');
        $('stat').textContent = parts.join(' · ');
      }).catch(function () {});
    }, 1000);
  }

  video.addEventListener('loadedmetadata', function () {
    connected = true;
    $('panel').classList.add('gone');
    $('who').textContent = from;
    $('hud').hidden = false;
    $('tap').hidden = !!document.fullscreenElement;
    wake();
  });

  // ---------- To'liq ekran va boshqaruv ----------
  function fullscreen() {
    var el = document.documentElement;
    var req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      return;
    }
    if (req) {
      var p = req.call(el);
      if (p && p.then) p.then(function () {
        try { screen.orientation.lock('landscape').catch(function () {}); } catch (x) {}
      }).catch(function () {});
    } else if (video.webkitEnterFullscreen) {
      video.webkitEnterFullscreen();
    }
    $('tap').hidden = true;
  }
  var idleTimer;
  function wake() {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () { document.body.classList.add('idle'); }, 3000);
  }
  ['touchstart', 'mousemove', 'keydown'].forEach(function (ev) { window.addEventListener(ev, wake, { passive: true }); });
  video.addEventListener('click', function () { if (connected && !control) fullscreen(); });

  // ---------- Teginish → kompyuter sichqonchasi ----------
  // Koordinata videoning o'zi ichida (qora chetlarsiz) 0..1 oralig'ida hisoblanadi.
  function norm(cx, cy) {
    var r = video.getBoundingClientRect();
    var vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return null;
    var s = Math.min(r.width / vw, r.height / vh);
    var w = vw * s, h = vh * s;
    var x0 = r.left + (r.width - w) / 2, y0 = r.top + (r.height - h) / 2;
    var x = (cx - x0) / w, y = (cy - y0) / h;
    if (x < -0.02 || x > 1.02 || y < -0.02 || y > 1.02) return null;
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  }

  var LONG_MS = 600, SLOP = 10;
  var ptrs = {};          // faol barmoqlar: id -> {x, y}
  var g = null;           // joriy imo-ishora
  var pendingMove = null, raf = 0;

  function flushMove() {
    raf = 0;
    if (pendingMove) { sendInput(pendingMove); pendingMove = null; }
  }
  function queueMove(m) {
    pendingMove = m;
    if (!raf) raf = requestAnimationFrame(flushMove);
  }
  function count() { return Object.keys(ptrs).length; }
  function mid() {
    var k = Object.keys(ptrs), x = 0, y = 0;
    for (var i = 0; i < k.length; i++) { x += ptrs[k[i]].x; y += ptrs[k[i]].y; }
    return { x: x / k.length, y: y / k.length };
  }

  video.addEventListener('pointerdown', function (e) {
    if (!control) return;
    e.preventDefault();
    try { video.setPointerCapture(e.pointerId); } catch (x) {}
    ptrs[e.pointerId] = { x: e.clientX, y: e.clientY };

    if (e.pointerType === 'mouse') {
      var p = norm(e.clientX, e.clientY);
      if (p) sendInput({ t: 'p', a: 'down', x: p.x, y: p.y, b: e.button === 2 ? 'r' : e.button === 1 ? 'm' : 'l' });
      return;
    }
    if (count() === 2) {
      // Ikkinchi barmoq: aylantirish rejimi. Birinchi barmoqning bosishini bekor qilamiz.
      if (g && g.timer) clearTimeout(g.timer);
      if (g && g.dragging) { var q = norm(g.lx, g.ly); if (q) sendInput({ t: 'p', a: 'up', x: q.x, y: q.y }); }
      var m = mid();
      g = { scroll: true, lx: m.x, ly: m.y, acc: 0, accx: 0 };
      return;
    }
    if (count() > 2) return;
    var p0 = norm(e.clientX, e.clientY);
    if (!p0) { g = null; return; }
    g = { sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, dragging: false, done: false };
    sendInput({ t: 'p', a: 'move', x: p0.x, y: p0.y });
    g.timer = setTimeout(function () {
      // Bosib turish → o'ng tugma
      if (!g || g.dragging || g.scroll) return;
      g.done = true;
      var p = norm(g.lx, g.ly);
      if (p) sendInput({ t: 'p', a: 'click', x: p.x, y: p.y, b: 'r' });
      if (navigator.vibrate) navigator.vibrate(15);
    }, LONG_MS);
  });

  video.addEventListener('pointermove', function (e) {
    if (!control) return;
    if (e.pointerType === 'mouse') {
      var pm = norm(e.clientX, e.clientY);
      if (pm) queueMove({ t: 'p', a: 'move', x: pm.x, y: pm.y });
      return;
    }
    if (!ptrs[e.pointerId]) return;
    ptrs[e.pointerId] = { x: e.clientX, y: e.clientY };
    if (!g) return;
    if (g.scroll) {
      var m = mid();
      g.acc += (m.y - g.ly) * 4;
      g.accx += (m.x - g.lx) * 4;
      g.lx = m.x; g.ly = m.y;
      if (Math.abs(g.acc) >= 30 || Math.abs(g.accx) >= 30) {
        sendInput({ t: 'w', dy: Math.round(g.acc), dx: Math.round(-g.accx) });
        g.acc = 0; g.accx = 0;
      }
      return;
    }
    if (g.done) return;
    g.lx = e.clientX; g.ly = e.clientY;
    if (!g.dragging && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) > SLOP) {
      // Sudrash boshlandi: boshlang'ich nuqtada tugmani bosib turamiz.
      clearTimeout(g.timer);
      g.dragging = true;
      var s = norm(g.sx, g.sy);
      if (s) sendInput({ t: 'p', a: 'down', x: s.x, y: s.y });
    }
    if (g.dragging) {
      var p = norm(e.clientX, e.clientY);
      if (p) queueMove({ t: 'p', a: 'move', x: p.x, y: p.y });
    }
  });

  function pointerEnd(e) {
    if (!control) return;
    if (e.pointerType === 'mouse') {
      var pm = norm(e.clientX, e.clientY) || { x: 0, y: 0 };
      sendInput({ t: 'p', a: 'up', x: pm.x, y: pm.y, b: e.button === 2 ? 'r' : e.button === 1 ? 'm' : 'l' });
      delete ptrs[e.pointerId];
      return;
    }
    delete ptrs[e.pointerId];
    if (!g) return;
    if (g.scroll) {
      if (count() === 0) g = null;
      return;
    }
    clearTimeout(g.timer);
    flushMove();
    var p = norm(g.lx, g.ly);
    if (p && !g.done) {
      if (g.dragging) sendInput({ t: 'p', a: 'up', x: p.x, y: p.y });
      else sendInput({ t: 'p', a: 'click', x: p.x, y: p.y, b: 'l' });
    }
    g = null;
  }
  video.addEventListener('pointerup', pointerEnd);
  video.addEventListener('pointercancel', pointerEnd);
  video.addEventListener('contextmenu', function (e) { if (control) e.preventDefault(); });
  video.addEventListener('wheel', function (e) {
    if (!control) return;
    e.preventDefault();
    sendInput({ t: 'w', dy: Math.round(-e.deltaY), dx: Math.round(e.deltaX) });
  }, { passive: false });

  // ---------- Klaviatura ----------
  $('kbBtn').addEventListener('click', function () {
    $('kb').hidden = false;
    $('kbText').focus();
  });
  $('kbClose').addEventListener('click', function () { $('kb').hidden = true; });
  $('kb').addEventListener('submit', function (e) {
    e.preventDefault();
    var s = $('kbText').value;
    if (s) sendInput({ t: 'txt', s: s });
    $('kbText').value = '';
  });
  Array.prototype.forEach.call(document.querySelectorAll('.kb [data-vk]'), function (b) {
    b.addEventListener('click', function () {
      var s = $('kbText').value;
      if (s) { sendInput({ t: 'txt', s: s }); $('kbText').value = ''; }
      sendInput({ t: 'k', vk: Number(b.getAttribute('data-vk')) });
      $('kbText').focus();
    });
  });
  $('fsBtn').addEventListener('click', fullscreen);
  $('soundBtn').addEventListener('click', function () {
    video.muted = false;
    video.play();
    $('soundBtn').hidden = true;
  });

  // ---------- PIN ----------
  pinInput.addEventListener('input', function () {
    pinInput.value = pinInput.value.replace(/\D/g, '').slice(0, 4);
    if (pinInput.value.length === 4) join(pinInput.value);
  });
  $('pinForm').addEventListener('submit', function (e) {
    e.preventDefault();
    join(pinInput.value);
  });

  var qs = /[?&]pin=(\d{4})/.exec(location.search);
  var saved = (qs && qs[1]) || load('uzat-pin');
  if (saved) {
    pinInput.value = saved;
    join(saved);
  } else {
    pinInput.focus();
  }
})();
