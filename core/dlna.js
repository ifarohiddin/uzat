'use strict';
// DLNA (UPnP AVTransport) — Android head unit, televizor kabi "Media Renderer" qurilmalarga
// "shu manzildagi videoni o'ynat" buyrug'ini yuborish.
const http = require('http');

const AVT = 'urn:schemas-upnp-org:service:AVTransport:1';

function soap(controlUrl, action, args, service = AVT) {
  const body =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${service}">` +
    Object.entries(args)
      .map(([k, v]) => `<${k}>${xmlEsc(String(v))}</${k}>`)
      .join('') +
    `</u:${action}></s:Body></s:Envelope>`;
  const u = new URL(controlUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        method: 'POST',
        timeout: 6000,
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          SOAPACTION: `"${service}#${action}"`,
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let d = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(d);
          else {
            const code = (d.match(/<errorCode>(\d+)<\/errorCode>/) || [])[1];
            const desc = (d.match(/<errorDescription>([^<]*)</) || [])[1];
            reject(new Error(`${action}: HTTP ${res.statusCode}${code ? ` (${code} ${desc || ''})` : ''}`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`${action}: javob kelmadi`)));
    req.on('error', reject);
    req.end(body);
  });
}

function xmlEsc(s) {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
}

function didl(url, title, mime) {
  return (
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">' +
    `<item id="uzat-live" parentID="0" restricted="1"><dc:title>${xmlEsc(title)}</dc:title>` +
    '<upnp:class>object.item.videoItem</upnp:class>' +
    `<res protocolInfo="http-get:*:${mime}:DLNA.ORG_OP=00;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000">${xmlEsc(url)}</res>` +
    '</item></DIDL-Lite>'
  );
}

async function play(controlUrl, mediaUrl, title = 'Uzat — ekran', mime = 'video/mpeg') {
  try {
    await soap(controlUrl, 'Stop', { InstanceID: 0 });
  } catch {}
  await soap(controlUrl, 'SetAVTransportURI', { InstanceID: 0, CurrentURI: mediaUrl, CurrentURIMetaData: didl(mediaUrl, title, mime) });
  await soap(controlUrl, 'Play', { InstanceID: 0, Speed: 1 });
}

const stop = (controlUrl) => soap(controlUrl, 'Stop', { InstanceID: 0 });

async function state(controlUrl) {
  const x = await soap(controlUrl, 'GetTransportInfo', { InstanceID: 0 });
  return (x.match(/<CurrentTransportState>([^<]*)</) || [])[1] || 'UNKNOWN';
}

// O'ynatish vaqti (masalan "0:00:12") — oldinga ketyaptimi, shundan video haqiqatan o'ynayotganini bilamiz.
async function position(controlUrl) {
  const x = await soap(controlUrl, 'GetPositionInfo', { InstanceID: 0 });
  return (x.match(/<RelTime>([^<]*)</) || [])[1] || '';
}

module.exports = { soap, play, stop, state, position };

// Buyruq qatoridan: node core/dlna.js play|stop|state <controlUrl> [mediaUrl]
if (require.main === module) {
  const [cmd, ctl, media] = process.argv.slice(2);
  const run = { play: () => play(ctl, media), stop: () => stop(ctl), state: () => state(ctl) }[cmd];
  if (!run) {
    console.log('node core/dlna.js play|stop|state <controlUrl> [mediaUrl]');
    process.exit(1);
  }
  run()
    .then((r) => console.log(cmd, 'OK', r || ''))
    .catch((e) => {
      console.error('XATO', e.message);
      process.exit(1);
    });
}
