import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import type { StudioApi } from '../shared/api.ts';

function subscribe<T>(channel: string, cb: (value: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, value: T) => cb(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: StudioApi = {
  pickWav: () => ipcRenderer.invoke('dialog:pickWav'),
  pathForDroppedFile: (file) => webUtils.getPathForFile(file),
  loadAudio: (path) => ipcRenderer.invoke('audio:load', path),
  onLoadProgress: (cb) => subscribe('audio:loadProgress', cb),
  readAudio: (start, count) => ipcRenderer.invoke('audio:read', start, count),
  startRecording: (dir, name, sampleRate, channels) => ipcRenderer.invoke('rec:start', dir, name, sampleRate, channels),
  appendRecording: (planes) => ipcRenderer.invoke('rec:append', planes),
  stopRecording: () => ipcRenderer.invoke('rec:stop'),
  takeStartupFile: () => ipcRenderer.invoke('app:takeStartupFile'),
  onOpenFile: (cb) => subscribe('app:openFile', cb),

  saveProject: (wavPath, project) => ipcRenderer.invoke('project:save', wavPath, project),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  getShortcutOverrides: () => ipcRenderer.invoke('shortcuts:get'),
  saveShortcutOverrides: (overrides) => ipcRenderer.invoke('shortcuts:save', overrides),

  pickFolder: (defaultPath) => ipcRenderer.invoke('dialog:pickFolder', defaultPath),
  existingFiles: (dir, names) => ipcRenderer.invoke('fs:existing', dir, names),
  listFiles: (dir) => ipcRenderer.invoke('fs:list', dir),
  showInFolder: (path) => ipcRenderer.invoke('shell:showInFolder', path),

  startExport: (req) => ipcRenderer.invoke('export:start', req),
  cancelExport: () => ipcRenderer.invoke('export:cancel'),
  onExportProgress: (cb) => subscribe('export:progress', cb),

  setDirty: (dirty) => ipcRenderer.send('app:setDirty', dirty),
  setTitle: (title) => ipcRenderer.send('app:setTitle', title),
  onSaveAndClose: (cb) => subscribe('app:saveAndClose', cb),
  closeNow: () => ipcRenderer.send('app:closeNow'),
  toggleDevTools: () => ipcRenderer.send('app:toggleDevTools'),
};

contextBridge.exposeInMainWorld('studio', api);
