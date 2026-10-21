import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppSettings,
  DiskGroveAPI,
  DeleteMode,
  DupProgress,
  ScanComplete,
  ScanProgress,
  SortSpec
} from '@shared/types'

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: DiskGroveAPI = {
  getMeta: () => ipcRenderer.invoke('app:meta'),
  listDrives: () => ipcRenderer.invoke('drives:list'),
  pickFolder: () => ipcRenderer.invoke('folder:pick'),
  resolveScanRoot: (path) => ipcRenderer.invoke('scan:resolve', path),
  startScan: (path, options) => ipcRenderer.invoke('scan:start', path, options),
  cancelScan: () => ipcRenderer.invoke('scan:cancel'),
  getChildren: (path, sort: SortSpec) => ipcRenderer.invoke('scan:children', path, sort),
  getNode: (path) => ipcRenderer.invoke('scan:node', path),
  getTopFiles: (path, limit) => ipcRenderer.invoke('scan:topfiles', path, limit),
  getExtensions: (path) => ipcRenderer.invoke('scan:extensions', path),
  getAgeStats: (path) => ipcRenderer.invoke('scan:age', path),
  getGroupFiles: (group, path, limit) => ipcRenderer.invoke('scan:group-files', group, path, limit),
  getTreemap: (path, maxDepth, minPercent) => ipcRenderer.invoke('scan:treemap', path, maxDepth, minPercent),
  search: (query, path, limit) => ipcRenderer.invoke('scan:search', query, path, limit),
  getUnreadable: (limit) => ipcRenderer.invoke('scan:unreadable', limit),
  findDuplicates: (path) => ipcRenderer.invoke('scan:duplicates', path),
  cancelDuplicates: () => ipcRenderer.invoke('dup:cancel'),
  openPath: (path) => ipcRenderer.invoke('item:open', path),
  revealPath: (path) => ipcRenderer.invoke('item:reveal', path),
  readFile: (path, offset, length) => ipcRenderer.invoke('item:read', path, offset, length),
  getItemTimes: (path) => ipcRenderer.invoke('item:times', path),
  deleteItems: (paths: string[], mode: DeleteMode) => ipcRenderer.invoke('items:delete', paths, mode),
  exportReport: (format) => ipcRenderer.invoke('export:report', format),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (partial: Partial<AppSettings>) => ipcRenderer.invoke('settings:set', partial),
  onSettingsChanged: (cb) => on<AppSettings>('settings:changed', cb),
  onProgress: (cb) => on<ScanProgress>('scan:progress', cb),
  onComplete: (cb) => on<ScanComplete>('scan:complete', cb),
  onError: (cb) => on<{ message: string }>('scan:error', cb),
  onDupProgress: (cb) => on<DupProgress>('dup:progress', cb),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  onMaximized: (cb) => on<boolean>('window:maximized', cb),
  isFullScreen: () => ipcRenderer.invoke('window:isFullScreen'),
  onFullScreen: (cb) => on<boolean>('window:fullscreen', cb)
}

contextBridge.exposeInMainWorld('diskgrove', api)
