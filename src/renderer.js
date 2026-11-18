'use strict';
(() => {
  const api = window.uzat;
  const { QUALITY } = RTC;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const initials = (name) =>
    (name || '?')
      .split(/[\s\-_.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0].toUpperCase())
      .join('') || '?';

  const WEB = 'web'; // "Brauzer" maqsadi: Android, televizor va h.k. brauzer orqali ko'radi

  // ---------- Holat ----------
  const S = {
    self: null,
    peers: [],
    sel: WEB,
    sources: [],
    srcId: null,
    quality: 'balanced',
    audio: false,
    control: false, // ko'ruvchi sichqoncha/klaviatura bilan boshqara oladimi
    phase: 'idle', // idle | capturing | asking | live
    mode: null, // 'web' | 'lan'
    viewer: null, // LAN rejimida ko'rayotgan qurilma nomi
    web: null, // { pin, urls }
    asks: [],
  };
  let stream = null;
  const conns = new Map(); // key -> { pc, ice, name, read }
  let statsTimer = null;

  // ---------- To'lqin (rasmdagi kabi bezak) ----------
  const HEIGHTS = [10, 30, 8, 40, 46, 16, 10, 26, 14, 22, 10, 6, 5, 5, 6, 5, 5, 7, 10, 18, 24, 30, 18, 36, 42, 26, 14, 9, 7, 12];
  const wave = $('wave');
  HEIGHTS.forEach((h, i) => {
    const b = document.createElement('i');
    b.style.height = `${h}px`;
    b.style.setProperty('--i', i);
    if (i < 11) b.className = 'on';
    wave.appendChild(b);
  });
  wave.classList.add('idle');

  // ---------- Elementlar ----------
  const card = $('card');
  const sub = $('sub');
  const subDefault = sub.textContent;
  const preview = $('preview');
  const thumb = $('thumb');
  const shareBtn = $('shareBtn');
  const shareTile = $('shareTile');

  function setSub(text, err) {
    sub.textContent = text || subDefault;
    sub.classList.toggle('err', !!err);
  }

  let toastTimer;
  function toast(text, kind) {
    const el = $('toast');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    $('toastText').textContent = text;
    el.hidden = false;
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 4500);
  }

  // ---------- Chizish ----------
  const currentSource = () => S.sources.find((s) => s.id === S.srcId);
  const targetName = () => (S.sel === WEB ? 'Brauzer' : (S.peers.find((p) => p.id === S.sel) || {}).name);

  function render() {
    const tname = targetName();
    const src = currentSource();
    const busy = S.phase !== 'idle';
    const live = S.phase === 'live';
    card.classList.toggle('busy', busy);
    card.classList.toggle('live', live);

    $('pointer').hidden = !tname;
    if (tname) {
      let tag = tname;
      if (live && S.mode === WEB) tag = conns.size ? `${conns.size} ko'ruvchi` : 'Brauzer';
      else if (live && S.viewer) tag = S.viewer;
      $('pointerTag').textContent = tag;
    }

    thumb.hidden = busy || !src || !src.thumb;
    if (src && src.thumb && thumb.src !== src.thumb) thumb.src = src.thumb;
    preview.hidden = !busy || !stream;
    $('liveBadge').hidden = !live;
    $('srcText').innerHTML = src ? `<b>${esc(src.name)}</b>` : 'Ekran tanlanmoqda…';

    const ready = !!tname && !!src && !busy;
    shareBtn.disabled = !(ready || busy);
    shareTile.disabled = !(ready || busy);
    shareBtn.textContent = busy ? "To'xtatish" : 'Ulashish';
    shareTile.title = busy ? "To'xtatish" : 'Ulashishni boshlash';
    $('pickBtn').disabled = busy;
    $('screenTile').disabled = busy;
    $('stats').hidden = !busy;

    const showWeb = live && S.mode === WEB && S.web;
    $('webInfo').hidden = !showWeb;
    sub.hidden = !!showWeb;
    if (showWeb) {
      const [first, ...rest] = S.web.urls;
      $('webUrl').textContent = first ? first.replace(/^http:\/\//, '') : '—';
      $('webPin').textContent = S.web.pin;
      $('webAlt').textContent = rest.length ? `Boshqa tarmoqda: ${rest.map((u) => u.replace(/^http:\/\//, '')).join(', ')}` : '';
    }

    const q = QUALITY[S.quality];
    $('qNote').textContent = `Hozir: ${q.label} · ${q.note}${S.audio ? ' · ovoz bilan' : ''}`;
    $('ctlBtn').classList.toggle('on', S.control);
    $('ctlText').textContent = S.control ? 'Boshqaruv yoqilgan' : "Boshqaruv o'chiq";
  }

  // ---------- Masofadan boshqarish ----------
  function broadcastControl() {
    for (const c of conns.values()) if (c.dc && c.dc.readyState === 'open') c.dc.send(JSON.stringify({ t: 'cfg', control: S.control }));
  }
  $('ctlBtn').addEventListener('click', async () => {
    S.control = !S.control;
    const r = await api.prefs({ control: S.control });
    S.control = r.control;
    if (S.control && S.phase !== 'idle' && !(await api.controlCapable())) {
      toast('Boshqaruv faqat butun ekran ulashilganda ishlaydi', 'bad');
    } else if (S.phase !== 'idle') toast(S.control ? "Ko'ruvchi endi kompyuterni boshqara oladi" : "Boshqaruv o'chirildi");
    broadcastControl();
    render();
  });
  api.on('control:unsupported', () => toast('Boshqaruv faqat butun ekran ulashilganda ishlaydi', 'bad'));

  function renderPeers() {
    const box = $('peers');
    box.textContent = '';
    const busy = S.phase !== 'idle';
    const chip = (id, avatar, name, title, globe) => {
      const c = document.createElement('button');
      c.type = 'button';
      c.className = 'chip' + (id === S.sel ? ' sel' : '');
      c.setAttribute('role', 'option');
      c.setAttribute('aria-selected', id === S.sel);
      c.title = title;
      c.disabled = busy && id !== S.sel;
      c.innerHTML = `<span class="av${globe ? ' globe' : ''}">${avatar}</span>${esc(name)}`;
      c.addEventListener('click', () => {
        if (S.phase !== 'idle') return;
        S.sel = id;
        renderPeers();
        render();
      });
      box.appendChild(c);
    };
    // Avval topilgan qurilmalar (DLNA: head unit, televizor), keyin Uzat kompyuterlar, oxirida brauzer.
    for (const p of S.peers.filter((x) => x.kind === 'dlna')) chip(p.id, '📺', p.name, `${p.address} — DLNA: ekran shu qurilmada o'zi ochiladi (boshqaruvsiz)`, true);
    for (const p of S.peers.filter((x) => x.kind !== 'dlna')) chip(p.id, esc(initials(p.name)), p.name, `${p.address} — Uzat o'rnatilgan kompyuter`);
    chip(WEB, '🌐', 'Brauzer', "Qurilmada brauzer ochib ko'radi — qo'l bilan boshqarish ham mumkin", true);
  }

  let autoPicked = false;
  function setPeers(list) {
    S.peers = list || [];
    if (S.phase === 'idle' && S.sel !== WEB && !S.peers.some((p) => p.id === S.sel)) S.sel = WEB;
    // DLNA qurilma birinchi marta topilganda uni o'zi tanlab qo'yamiz.
    const tv = S.peers.find((p) => p.kind === 'dlna');
    if (S.phase === 'idle' && S.sel === WEB && tv && !autoPicked) {
      autoPicked = true;
      S.sel = tv.id;
    }
    renderPeers();
    render();
  }

  // ---------- Ekran manbalari ----------
  async function loadSources() {
    try {
      const r = await api.sources();
      S.sources = r.list;
      S.srcId = r.selected;
    } catch {
      S.sources = [];
    }
    render();
  }

  function renderPicker() {
    const grid = $('srcGrid');
    grid.textContent = '';
    for (const s of S.sources) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'src' + (s.id === S.srcId ? ' sel' : '');
      b.innerHTML = `<img alt="" src="${s.thumb}"><span>${s.kind === 'screen' ? '🖥 ' : ''}${esc(s.name)}</span>`;
      b.addEventListener('click', () => {
        S.srcId = s.id;
        api.setSource(s.id);
        renderPicker();
        render();
      });
      grid.appendChild(b);
    }
    const seg = $('qualitySeg');
    seg.textContent = '';
    for (const [k, q] of Object.entries(QUALITY)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = k === S.quality ? 'sel' : '';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', k === S.quality);
      b.innerHTML = `<b>${q.label}</b><small>${q.note}</small>`;
      b.addEventListener('click', async () => {
        S.quality = k;
        await api.prefs({ quality: k });
        renderPicker();
        render();
      });
      seg.appendChild(b);
    }
    $('audioBox').checked = S.audio;
  }

  async function openPicker() {
    if (S.phase !== 'idle') return;
    await loadSources();
    renderPicker();
    $('pickWrap').hidden = false;
  }
  $('pickBtn').addEventListener('click', openPicker);
  $('screenTile').addEventListener('click', openPicker);
  $('pickDone').addEventListener('click', () => ($('pickWrap').hidden = true));
  $('pickWrap').addEventListener('click', (e) => {
    if (e.target === $('pickWrap')) $('pickWrap').hidden = true;
  });
  $('audioBox').addEventListener('change', async (e) => {
    S.audio = e.target.checked;
    await api.prefs({ audio: S.audio });
    render();
  });

  // ---------- WebRTC ulanishlari (har bir ko'ruvchiga bittadan) ----------
  async function openConn(key, name, sendFn) {
    closeConn(key);
    const q = QUALITY[S.quality];
    const pc = new RTCPeerConnection(RTC.config);
    const c = { pc, ice: RTC.iceQueue(pc), name, send: sendFn, q, read: RTC.statsReader(pc, 'out') };
    conns.set(key, c);
    let videoSender = null;
    for (const t of stream.getTracks()) {
      const tr = pc.addTransceiver(t, { direction: 'sendonly', streams: [stream] });
      if (t.kind === 'video') {
        RTC.preferCodecs(tr);
        videoSender = tr.sender;
      }
    }
    // Ko'ruvchidan sichqoncha/klaviatura hodisalari uchun kanal (kechikishsiz, tartib bilan).
    const dc = pc.createDataChannel('input', { ordered: true });
    c.dc = dc;
    dc.onopen = () => dc.send(JSON.stringify({ t: 'cfg', control: S.control }));
    dc.onmessage = (e) => {
      if (!S.control) return;
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      api.input(m);
    };
    dc.onclose = () => api.releaseInput();

    pc.onicecandidate = (e) => e.candidate && sendFn({ t: 'ice', c: e.candidate.toJSON() });
    pc.onconnectionstatechange = () => {
      if (conns.get(key) !== c) return;
      if (pc.connectionState === 'connected') {
        if (S.mode === 'lan') setSub(`${name} ekraningizni ko'rmoqda`);
        else toast(`${name} ulandi`, 'ok');
        render();
      }
      if (pc.connectionState === 'failed') {
        closeConn(key);
        if (S.mode === 'lan') {
          toast('Ulanish uzildi', 'bad');
          stop();
        } else api.webKick(key);
      }
    };
    await pc.setLocalDescription(await pc.createOffer());
    sendFn({ t: 'sdp', sdp: pc.localDescription.toJSON() });

    if (videoSender) {
      const p = videoSender.getParameters();
      p.degradationPreference = q.deg;
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      Object.assign(p.encodings[0], { maxBitrate: q.bitrate, maxFramerate: q.fps, priority: 'high', networkPriority: 'high' });
      await videoSender.setParameters(p).catch(() => {});
    }
    render();
  }

  function closeConn(key) {
    const c = conns.get(key);
    if (!c) return;
    conns.delete(key);
    c.pc.close();
    render();
  }

  async function onSignal(key, m) {
    const c = conns.get(key);
    if (!c) return;
    if (m.t === 'sdp' && m.sdp && m.sdp.type === 'answer') {
      await c.pc.setRemoteDescription({ type: 'answer', sdp: RTC.boostBitrate(m.sdp.sdp, Math.round(c.q.bitrate / 1000)) });
      await c.ice.flush();
    } else if (m.t === 'ice' && m.c) {
      await c.ice.add(m.c);
    }
  }

  const LIMITS = { bandwidth: 'tarmoq cheklayapti', cpu: 'protsessor band' };
  function startStats() {
    clearInterval(statsTimer);
    statsTimer = setInterval(async () => {
      if (S.phase !== 'live') return;
      const first = conns.values().next().value;
      if (!first) {
        $('statMain').textContent = S.mode === WEB ? "Ko'ruvchi kutilmoqda…" : 'Ulanmoqda…';
        $('statSub').textContent = S.mode === WEB ? 'Qurilmada manzilni oching va PIN kiriting' : '';
        return;
      }
      const s = await first.read().catch(() => null);
      if (!s || !s.w) return;
      const head = S.mode === WEB ? `${conns.size} ko'ruvchi · ` : '';
      $('statMain').textContent = head + RTC.fmtStats(s);
      const extra = [s.codec, s.encoder && !/unknown/i.test(s.encoder) ? s.encoder.replace('VideoEncodeAccelerator', ' (GPU)') : null, LIMITS[s.limit]].filter(Boolean);
      $('statSub').textContent = extra.join(' · ');
    }, 1000);
  }

  // ---------- Ulashish ----------
  function cleanup() {
    clearInterval(statsTimer);
    statsTimer = null;
    for (const k of [...conns.keys()]) closeConn(k);
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    preview.srcObject = null;
    S.phase = 'idle';
    S.mode = null;
    S.viewer = null;
    S.web = null;
    $('statMain').textContent = 'Ulanmoqda…';
    $('statSub').textContent = '';
    renderPeers();
    render();
  }

  async function stop() {
    if (S.phase === 'idle') return;
    const mode = S.mode;
    stopRecorders();
    cleanup();
    setSub();
    if (mode === WEB) await api.webStop();
    else if (mode === 'dlna') await api.dlnaStop();
    else await api.stop();
  }

  // ---------- DLNA: qurilma o'zi o'ynatadigan jonli video ----------
  // Qurilma oqim manziliga har ulanganda yangi yozuvchi ochamiz — video boshidan (kalit kadr bilan) boradi.
  const FORMATS = {
    mp4: { mime: 'video/mp4;codecs=avc1.42E01F', ext: 'mp4' },
    mkv: { mime: 'video/x-matroska;codecs=avc1', ext: 'mkv' },
    webm: { mime: 'video/webm;codecs=vp8', ext: 'webm' },
  };
  function pickFormat() {
    const order = [S.self && S.self.dlnaFormat, 'mp4', 'mkv', 'webm'].filter(Boolean);
    for (const k of order) if (FORMATS[k] && MediaRecorder.isTypeSupported(FORMATS[k].mime)) return { key: k, ...FORMATS[k] };
    return null;
  }
  const recorders = new Map(); // rid -> MediaRecorder
  let dlnaFmt = null;
  let recBytes = 0;
  let dlnaState = '';

  function startRecorder(rid) {
    if (!stream || !dlnaFmt) return;
    const q = QUALITY[S.quality];
    const ms = new MediaStream(stream.getVideoTracks());
    // Har soniyada kalit kadr: MP4 bo'laklari tez chiqadi → qurilmada tezroq ochiladi va kechikish kamayadi.
    const rec = new MediaRecorder(ms, {
      mimeType: dlnaFmt.mime,
      videoBitsPerSecond: Math.min(q.bitrate, 10e6),
      videoKeyFrameIntervalDuration: 1000,
    });
    rec.ondataavailable = async (e) => {
      if (!e.data || !e.data.size || !recorders.has(rid)) return;
      const buf = new Uint8Array(await e.data.arrayBuffer());
      recBytes += buf.length;
      api.recChunk(rid, buf);
    };
    rec.start(100);
    recorders.set(rid, rec);
  }
  function stopRecorder(rid) {
    const r = recorders.get(rid);
    recorders.delete(rid);
    if (r && r.state !== 'inactive') r.stop();
  }
  function stopRecorders() {
    for (const rid of [...recorders.keys()]) stopRecorder(rid);
  }
  api.on('rec:start', ({ rid }) => (S.mode === 'dlna' && S.phase === 'live' ? startRecorder(rid) : null));
  api.on('rec:stop', ({ rid }) => stopRecorder(rid));

  async function startDlna() {
    const peer = S.peers.find((p) => p.id === S.sel);
    dlnaFmt = pickFormat();
    if (!dlnaFmt) {
      cleanup();
      setSub('Bu kompyuterda video yozib bo‘lmadi (MediaRecorder)', true);
      return;
    }
    S.phase = 'live'; // qurilma ulanishi bilan yozuvchi ishga tushishi uchun oldinroq
    S.viewer = peer.name;
    setSub(`${peer.name} ekranida ochilmoqda…`);
    render();
    const r = await api.dlnaStart({ peerId: peer.id, mime: dlnaFmt.mime, ext: dlnaFmt.ext });
    if (S.mode !== 'dlna') return;
    if (!r.ok) {
      stopRecorders();
      cleanup();
      setSub();
      toast(r.error, 'bad');
      return;
    }
    recBytes = 0;
    let last = 0;
    clearInterval(statsTimer);
    statsTimer = setInterval(() => {
      const mbps = ((recBytes - last) * 8) / 1e6;
      last = recBytes;
      const st = { PLAYING: "o'ynatilmoqda", TRANSITIONING: 'yuklanmoqda', PAUSED_PLAYBACK: 'pauza', STOPPED: "to'xtagan" }[dlnaState] || 'kutilmoqda';
      $('statMain').textContent = `${peer.name} · ${st}`;
      $('statSub').textContent = `DLNA · ${dlnaFmt.key.toUpperCase()} · ${mbps.toFixed(1)} Mbit/s · ${recorders.size ? 'oqim ketmoqda' : 'qurilma ulanmadi'}`;
    }, 1000);
    if (location.hash === '#e2e') window.__e2eDlna = { fmt: dlnaFmt.key, url: r.url };
  }
  api.on('dlna:state', ({ state }) => {
    dlnaState = state;
    if (state === 'PLAYING' && S.mode === 'dlna') setSub(`${S.viewer} ekraningizni ko'rsatmoqda`);
  });
  api.on('dlna:ended', ({ name }) => {
    if (S.mode !== 'dlna') return;
    stopRecorders();
    cleanup();
    setSub();
    toast(`${name} da o'ynatish to'xtatildi`);
  });

  async function capture() {
    const q = QUALITY[S.quality];
    await api.setSource(S.srcId);
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { max: q.w }, height: { max: q.h }, frameRate: { ideal: q.fps, max: q.fps } },
      audio: S.audio,
    });
    const vt = stream.getVideoTracks()[0];
    vt.contentHint = q.hint;
    vt.addEventListener('ended', () => {
      // Masalan, ulashilayotgan oyna yopilsa.
      if (S.phase !== 'idle') {
        toast('Ulashilayotgan oyna yopildi', 'bad');
        stop();
      }
    });
    preview.srcObject = stream;
    preview.play().catch(() => {});
  }

  async function start() {
    if (S.phase !== 'idle') return stop();
    const tname = targetName();
    if (!tname || !currentSource()) return;

    S.phase = 'capturing';
    const target = S.peers.find((p) => p.id === S.sel);
    S.mode = S.sel === WEB ? WEB : target && target.kind === 'dlna' ? 'dlna' : 'lan';
    setSub('Ekran olinmoqda…');
    render();
    try {
      await capture();
    } catch (e) {
      cleanup();
      setSub(`Ekranni olib bo'lmadi: ${e.message}`, true);
      return;
    }

    if (S.mode === 'dlna') return startDlna();

    if (S.mode === WEB) {
      const r = await api.webStart();
      if (!r.ok) {
        cleanup();
        setSub(r.error, true);
        return;
      }
      S.web = { pin: r.pin, urls: r.urls };
      S.phase = 'live';
      renderPeers();
      render();
      startStats();
      if (location.hash === '#e2e') window.__e2eWeb = S.web;
      return;
    }

    // Uzat o'rnatilgan boshqa kompyuterga
    const peer = S.peers.find((p) => p.id === S.sel);
    S.phase = 'asking';
    renderPeers();
    setSub(`${peer.name} ruxsat berishini kutyapmiz…`);
    render();
    const res = await api.request({ peerId: peer.id, source: currentSource().name });
    if (S.phase !== 'asking') return; // kutish paytida to'xtatilgan
    if (!res.ok) {
      cleanup();
      setSub();
      toast(res.error || "Ulanib bo'lmadi", 'bad');
      return;
    }
    S.viewer = res.peer;
    S.phase = 'live';
    setSub(`${res.peer} ulanmoqda…`);
    try {
      await openConn('lan', res.peer, (m) => api.signal(m));
    } catch (e) {
      toast(`Ulanishda xato: ${e.message}`, 'bad');
      stop();
      return;
    }
    startStats();
    if (location.hash === '#e2e') setTimeout(() => api.shot('live'), 5000);
  }

  // LAN (Uzat ↔ Uzat)
  api.on('share:signal', (m) => onSignal('lan', m));
  api.on('share:ended', ({ reason, peer }) => {
    if (S.phase === 'idle' || S.mode !== 'lan') return;
    cleanup();
    setSub();
    if (reason !== 'local') toast(`${peer} ko'rishni yakunladi`);
  });

  // Brauzer ko'ruvchilari
  api.on('web:join', ({ vid, name }) => {
    if (S.phase !== 'live' || S.mode !== WEB || !stream) return api.webKick(vid);
    openConn(vid, name, (m) => api.webSignal({ vid, m })).catch(() => api.webKick(vid));
  });
  api.on('web:signal', ({ vid, m }) => onSignal(vid, m));
  api.on('web:leave', ({ vid }) => {
    const c = conns.get(vid);
    if (!c) return;
    closeConn(vid);
    if (S.phase === 'live') toast(`${c.name} uzildi`);
  });

  shareBtn.addEventListener('click', start);
  shareTile.addEventListener('click', start);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.ctrlKey) start();
    if (e.key === 'Escape') $('pickWrap').hidden = true;
  });

  // ---------- Kiruvchi so'rov (boshqa Uzat'dan) ----------
  function showAsk() {
    const a = S.asks[0];
    $('askWrap').hidden = !a;
    if (!a) return;
    $('askTitle').textContent = `${a.from} ekranini ko'rsatmoqchi`;
    $('askBody').textContent = a.source ? `Ulashiladi: ${a.source}` : 'Ekran ulashish so‘rovi';
    $('trustBox').checked = false;
    $('acceptBtn').focus();
  }
  function answer(accept) {
    const a = S.asks.shift();
    if (a) api.answer({ sid: a.sid, accept, trust: accept && $('trustBox').checked, fromId: a.fromId });
    showAsk();
  }
  $('acceptBtn').addEventListener('click', () => answer(true));
  $('rejectBtn').addEventListener('click', () => answer(false));
  api.on('share:ask', (a) => {
    S.asks.push(a);
    if (S.asks.length === 1) showAsk();
  });
  api.on('share:ask-cancelled', ({ sid }) => {
    const i = S.asks.findIndex((a) => a.sid === sid);
    if (i < 0) return;
    S.asks.splice(i, 1);
    if (i === 0) showAsk();
  });

  api.on('peers', setPeers);
  api.on('net:error', (m) => setSub(`Tarmoq xatosi: ${m}`, true));

  // ---------- Nom ----------
  const meBtn = $('meBtn');
  const meInput = $('meInput');
  meBtn.addEventListener('click', () => {
    meInput.value = S.self ? S.self.name : '';
    meBtn.hidden = true;
    meInput.hidden = false;
    meInput.focus();
    meInput.select();
  });
  async function saveName(commit) {
    if (meInput.hidden) return;
    if (commit) {
      const name = await api.rename(meInput.value);
      if (S.self) S.self.name = name;
      $('meName').textContent = name;
    }
    meInput.hidden = true;
    meBtn.hidden = false;
  }
  meInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveName(true);
    if (e.key === 'Escape') {
      e.stopPropagation();
      saveName(false);
    }
  });
  meInput.addEventListener('blur', () => saveName(true));

  // Oyna faollashganda ekran ko'rinishini yangilab qo'yamiz.
  window.addEventListener('focus', () => S.phase === 'idle' && $('pickWrap').hidden && loadSources());

  // ---------- Ishga tushish ----------
  (async () => {
    S.self = await api.self();
    S.quality = S.self.quality;
    S.audio = S.self.audio;
    S.control = !!S.self.control;
    $('meName').textContent = S.self.name;
    document.querySelector('.brand').classList.add('online');
    await loadSources();
    setPeers(await api.peers());
  })();
  renderPeers();
  render();

  if (location.hash === '#e2e') {
    window.__e2e = {
      start,
      selectWeb: () => {
        S.sel = WEB;
        renderPeers();
        render();
      },
      selectFirstPeer: () => {
        if (S.peers[0]) S.sel = S.peers[0].id;
        renderPeers();
        render();
      },
      selectByName: (name) => {
        const p = S.peers.find((x) => x.name === name);
        if (p) S.sel = p.id;
        renderPeers();
        render();
        return !!p;
      },
      dlna: () => ({ ...(window.__e2eDlna || {}), state: dlnaState, bytes: recBytes, streams: recorders.size }),
      stop,
      stats: async () => {
        const c = conns.values().next().value;
        return c ? c.read() : null;
      },
      web: () => window.__e2eWeb || null,
    };
  }
})();
