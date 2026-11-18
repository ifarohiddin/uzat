'use strict';
// Ikkala oyna uchun umumiy WebRTC sozlamalari.
window.RTC = (() => {
  const QUALITY = {
    fast: { label: 'Tez', note: '720p · 60 fps', w: 1280, h: 720, fps: 60, bitrate: 6e6, hint: 'motion', deg: 'maintain-framerate' },
    balanced: { label: 'Muvozanat', note: '1080p · 60 fps', w: 1920, h: 1080, fps: 60, bitrate: 14e6, hint: 'motion', deg: 'balanced' },
    sharp: { label: 'Aniq', note: 'Asl o‘lcham · 30 fps', w: 3840, h: 2160, fps: 30, bitrate: 28e6, hint: 'detail', deg: 'maintain-resolution' },
  };

  // Lokal tarmoqda tashqi server kerak emas — ICE faqat mahalliy manzillardan foydalanadi.
  const config = { iceServers: [], bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' };

  // Videokarta kodlay oladigan H.264 ni birinchi qo'yamiz, keyin VP8/VP9.
  function preferCodecs(transceiver) {
    const caps = RTCRtpSender.getCapabilities && RTCRtpSender.getCapabilities('video');
    if (!caps || !transceiver.setCodecPreferences) return;
    const rank = (c) => {
      const m = c.mimeType.toLowerCase();
      if (m === 'video/h264') return /packetization-mode=1/.test(c.sdpFmtpLine || '') ? 0 : 1;
      if (m === 'video/vp8') return 2;
      if (m === 'video/vp9') return 3;
      if (m === 'video/av1') return 4;
      return 5; // rtx, red, ulpfec
    };
    const sorted = [...caps.codecs].sort((a, b) => rank(a) - rank(b));
    try {
      transceiver.setCodecPreferences(sorted);
    } catch {}
  }

  // Lokal tarmoqda bitreytni noldan sekin ko'tarmaslik uchun boshlang'ich qiymatni beramiz.
  function boostBitrate(sdp, kbps) {
    return sdp.replace(/a=fmtp:(\d+) (.*)\r\n/g, (line, pt, params) => {
      if (/x-google-start-bitrate/.test(params)) return line;
      const isVideo = new RegExp(`a=rtpmap:${pt} (H264|VP8|VP9|AV1)/`).test(sdp);
      if (!isVideo) return line;
      return `a=fmtp:${pt} ${params};x-google-start-bitrate=${Math.round(kbps * 0.6)};x-google-min-bitrate=1000;x-google-max-bitrate=${kbps}\r\n`;
    });
  }

  // getStats dan o'qiladigan qisqa ma'lumot: o'lcham, fps, bitreyt, kechikish.
  function statsReader(pc, dir) {
    let lastBytes = 0;
    let lastT = 0;
    return async () => {
      const r = await pc.getStats();
      const s = {};
      r.forEach((x) => {
        if (x.type === (dir === 'out' ? 'outbound-rtp' : 'inbound-rtp') && x.kind === 'video') {
          s.w = x.frameWidth;
          s.h = x.frameHeight;
          s.fps = x.framesPerSecond;
          s.bytes = dir === 'out' ? x.bytesSent : x.bytesReceived;
          s.t = x.timestamp;
          s.limit = x.qualityLimitationReason;
          s.decoded = x.framesDecoded;
          s.dropped = x.framesDropped;
          if (x.jitterBufferEmittedCount) s.buffer = (x.jitterBufferDelay / x.jitterBufferEmittedCount) * 1000;
          s.codecId = x.codecId;
          s.encoder = x.encoderImplementation || x.decoderImplementation;
        }
        if (x.type === 'candidate-pair' && x.nominated && x.state === 'succeeded' && x.currentRoundTripTime != null) {
          s.rtt = x.currentRoundTripTime * 1000;
        }
      });
      if (s.codecId) {
        const c = r.get(s.codecId);
        if (c) s.codec = c.mimeType.split('/')[1];
      }
      if (s.bytes != null && lastT) s.mbps = ((s.bytes - lastBytes) * 8) / ((s.t - lastT) * 1000);
      if (s.bytes != null) {
        lastBytes = s.bytes;
        lastT = s.t;
      }
      return s;
    };
  }

  function fmtStats(s) {
    const parts = [];
    if (s.w) parts.push(`${s.w}×${s.h}`);
    if (s.fps != null) parts.push(`${Math.round(s.fps)} fps`);
    if (s.mbps != null) parts.push(`${s.mbps.toFixed(1)} Mbit/s`);
    if (s.rtt != null) parts.push(`${Math.max(1, Math.round(s.rtt))} ms`);
    return parts.join(' · ');
  }

  // ICE nomzodlarini masofaviy tavsif o'rnatilmaguncha navbatda saqlash.
  function iceQueue(pc) {
    const q = [];
    return {
      add: async (c) => {
        if (pc.remoteDescription) await pc.addIceCandidate(c).catch(() => {});
        else q.push(c);
      },
      flush: async () => {
        while (q.length) await pc.addIceCandidate(q.shift()).catch(() => {});
      },
    };
  }

  return { QUALITY, config, preferCodecs, boostBitrate, statsReader, fmtStats, iceQueue };
})();
