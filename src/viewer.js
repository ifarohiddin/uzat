'use strict';
(async () => {
  const api = window.uzat;
  const $ = (id) => document.getElementById(id);
  const video = $('video');

  // ---------- Holat ekrani ----------
  function state(title, sub, spinning) {
    $('state').classList.remove('gone');
    $('stateTitle').textContent = title;
    $('stateSub').textContent = sub || '';
    $('spinner').hidden = !spinning;
  }
  const hideState = () => $('state').classList.add('gone');

  // ---------- WebRTC (qabul qiluvchi) ----------
  const pc = new RTCPeerConnection(RTC.config);
  const ice = RTC.iceQueue(pc);
  let ended = false;

  pc.ontrack = (e) => {
    // Eslatma: jitterBufferTarget/playoutDelayHint = 0 sinovda kadrlarning ko'pini tashlatdi (12 fps),
    // standart bufer esa ~15 ms kechikish bilan ~50 fps beradi — shuning uchun tegmaymiz.
    const ms = e.streams[0] || new MediaStream([e.track]);
    if (video.srcObject !== ms) video.srcObject = ms;
    video.play().catch(() => {});
  };
  pc.onicecandidate = (e) => e.candidate && api.viewerSignal({ t: 'ice', c: e.candidate.toJSON() });
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' && !ended) end('Ulanish uzildi');
  };

  api.on('viewer:signal', async (m) => {
    try {
      if (m.t === 'sdp' && m.sdp && m.sdp.type === 'offer') {
        await pc.setRemoteDescription(m.sdp);
        await ice.flush();
        await pc.setLocalDescription(await pc.createAnswer());
        api.viewerSignal({ t: 'sdp', sdp: pc.localDescription.toJSON() });
      } else if (m.t === 'ice' && m.c) {
        await ice.add(m.c);
      }
    } catch (e) {
      end(`Xato: ${e.message}`);
    }
  });
  api.on('viewer:ended', () => end('Ulashish yakunlandi'));

  function end(msg) {
    if (ended) return;
    ended = true;
    clearInterval(statsTimer);
    pc.close();
    state(msg, 'Oyna yopilmoqda…', false);
    setTimeout(() => api.closeViewer(), 1800);
  }

  let sized = false;
  video.addEventListener('loadedmetadata', () => {
    hideState();
    if (!sized && video.videoWidth) {
      sized = true;
      api.aspect(video.videoWidth / video.videoHeight);
    }
  });
  video.addEventListener('resize', () => video.videoWidth && hideState());

  // ---------- Statistika ----------
  const read = RTC.statsReader(pc, 'in');
  let last = {};
  const statsTimer = setInterval(async () => {
    const s = await read().catch(() => null);
    if (!s || !s.w) return;
    last = s;
    const parts = [RTC.fmtStats(s)];
    if (s.buffer != null) parts.push(`bufer ${Math.round(s.buffer)} ms`);
    $('stat').textContent = parts.join(' · ');
  }, 1000);

  // ---------- Boshqaruv ----------
  let idleTimer;
  const wake = () => {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => document.body.classList.add('idle'), 2500);
  };
  ['mousemove', 'mousedown', 'keydown'].forEach((ev) => window.addEventListener(ev, wake));
  wake();

  const toggleFs = async (on) => document.body.classList.toggle('fs', await api.fullscreen(on));
  $('fsBtn').addEventListener('click', () => toggleFs());
  video.addEventListener('dblclick', () => toggleFs());
  $('closeBtn').addEventListener('click', () => api.closeViewer());
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F11') {
      e.preventDefault();
      toggleFs();
    }
    if (e.key === 'Escape') toggleFs(false);
  });

  // ---------- Boshlash ----------
  state('Ulanmoqda…', '', true);
  const info = await api.viewerInfo();
  if (info) {
    $('who').textContent = info.from;
    document.title = `${info.from} ekrani — Uzat`;
    state(`${info.from} ekraniga ulanmoqda…`, '', true);
  }

  // Avtomatik sinov holatni shu orqali o'qiydi (faqat o'qish).
  window.__e2e = {
    stats: async () => ({ ...last, videoWidth: video.videoWidth, videoHeight: video.videoHeight, connection: pc.connectionState }),
  };
})();
