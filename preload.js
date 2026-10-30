'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('j', {
  platform: process.platform,
  listKits: () => ipcRenderer.invoke('kits:list'),
  podmanStatus: () => ipcRenderer.invoke('podman:status'),
  ps: (id) => ipcRenderer.invoke('kit:ps', id),
  start: (id) => ipcRenderer.invoke('kit:start', id),
  stop: (id) => ipcRenderer.invoke('kit:stop', id),
  wipe: (id) => ipcRenderer.invoke('kit:wipe', id),
  logsStart: (id) => ipcRenderer.invoke('kit:logsStart', id),
  logsStop: (id) => ipcRenderer.invoke('kit:logsStop', id),
  openExternal: (id) => ipcRenderer.invoke('kit:openExternal', id),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (llm) => ipcRenderer.invoke('settings:set', llm),
  onLog: (cb) => ipcRenderer.on('kit:log', (_e, m) => cb(m)),
  onState: (cb) => ipcRenderer.on('kit:state', (_e, m) => cb(m)),
});
