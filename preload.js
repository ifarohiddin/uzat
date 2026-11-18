'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (ch, fn) => {
  const h = (_e, d) => fn(d);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.off(ch, h);
};
const call = (ch) => (arg) => ipcRenderer.invoke(ch, arg);

contextBridge.exposeInMainWorld('uzat', {
  // asosiy oyna
  self: call('self'),
  peers: call('peers'),
  rename: call('rename'),
  prefs: call('prefs'),
  sources: call('sources'),
  setSource: call('source:set'),
  request: call('share:request'),
  signal: call('share:signal'),
  stop: call('share:stop'),
  answer: call('share:answer'),
  webStart: call('web:start'),
  webStop: call('web:stop'),
  webSignal: call('web:signal'),
  webKick: call('web:kick'),
  dlnaStart: call('dlna:start'),
  dlnaStop: call('dlna:stop'),
  recChunk: (rid, buf) => ipcRenderer.send('rec:chunk', { rid, buf }),
  input: (m) => ipcRenderer.send('input', m),
  releaseInput: call('input:release'),
  controlCapable: call('control:capable'),
  // ko'rish oynasi
  viewerInfo: call('viewer:info'),
  viewerSignal: call('viewer:signal'),
  fullscreen: call('viewer:fullscreen'),
  aspect: call('viewer:aspect'),
  closeViewer: call('viewer:close'),
  shot: (name) => ipcRenderer.send('e2e:shot', name),
  on,
});
