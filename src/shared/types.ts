import type { ThemeMode } from './themes'

export type { ThemeMode }

export type NodeKind = 'file' | 'dir'

export type DriveKind = 'fixed' | 'removable' | 'network' | 'optical' | 'unknown'

export type RightTab =
  'details' | 'treemap' | 'pie' | 'bar' | 'extensions' | 'topfiles' | 'age' | 'duplicates' | 'search'

export type SortKey = 'name' | 'size' | 'allocated' | 'files' | 'folders' | 'mtime' | 'percent'

export type SortDir = 'asc' | 'desc'

export type DeleteMode = 'trash' | 'permanent'

/** `folder` searches the folder selected in the tree; `all` searches the whole scan. */
export type SearchScope = 'folder' | 'all'

export interface DriveInfo {
  path: string
  label: string
  name: string
  fsType: string
  total: number
  free: number
  used: number
  kind: DriveKind
}

export interface NodeSummary {
  path: string
  name: string
  kind: NodeKind
  size: number
  allocated: number
  mtime: number
  atime: number
  ctime: number
  fileCount: number
  folderCount: number
  ext: string
  parentPath: string | null
  hasSubdirs: boolean
  unreadable?: boolean
}

export interface ChildrenResult {
  dirs: NodeSummary[]
  files: NodeSummary[]
  parent: NodeSummary | null
}

export interface SortSpec {
  key: SortKey
  dir: SortDir
}

export interface ScanProgress {
  running: boolean
  rootPath: string
  files: number
  folders: number
  bytes: number
  allocated: number
  unreadable: number
  currentPath: string
  elapsedMs: number
}

export interface ScanComplete {
  rootPath: string
  files: number
  folders: number
  bytes: number
  allocated: number
  unreadable: number
  elapsedMs: number
  freeSpace: number
  totalSpace: number
  /** Scan root is a whole drive or mount, so its free space belongs in the charts. */
  isVolumeRoot: boolean
  /** The scan was stopped early, so the totals cover only what it reached. */
  cancelled: boolean
}

export interface ExtensionStat {
  ext: string
  category: string
  count: number
  size: number
  percent: number
}

export interface AgeBucket {
  id: string
  label: string
  count: number
  size: number
  percent: number
}

/** The files behind one row of the File types or File age view. */
export type FileGroup = { by: 'ext'; ext: string } | { by: 'age'; id: string }

export interface TreemapNode {
  path: string
  name: string
  kind: NodeKind
  value: number
  ext: string
  children?: TreemapNode[]
}

export interface SearchResult {
  /** The folder that was searched, subfolders included. */
  root: string
  /** The largest matches, at most the requested number. */
  hits: NodeSummary[]
  /** Every match in the folder, including those beyond the limit. */
  total: number
}

export interface UnreadableItem {
  path: string
  kind: NodeKind
  folder: string
  code: string
}

export interface UnreadableList {
  folders: number
  files: number
  /** The first ones found, at most the requested number. */
  items: UnreadableItem[]
}

export interface DuplicateFile {
  path: string
  name: string
  mtime: number
}

export interface DuplicateGroup {
  hash: string
  size: number
  count: number
  wasted: number
  files: DuplicateFile[]
}

export interface DeleteFailure {
  path: string
  error: string
}

export interface DeleteResult {
  mode: DeleteMode
  deleted: string[]
  failed: DeleteFailure[]
}

export interface RecentScan {
  path: string
  scannedAt: number
  size: number
  files: number
}

export interface AppSettings {
  theme: ThemeMode
  followLinks: boolean
  skipHidden: boolean
  /** Names, `*`/`?` patterns and absolute paths that scans leave out. */
  exclude: string[]
  showFreeSpace: boolean
  showPreview: boolean
  fontScale: number
  searchScope: SearchScope
  recents: RecentScan[]
}

export interface AppMeta {
  platform: string
  home: string
}

export interface FileChunk {
  bytes: Uint8Array
  offset: number
  size: number
}

export interface ItemTimes {
  created: number
  modified: number
  accessed: number
}

export interface DupProgress {
  phase: 'grouping' | 'hashing' | 'done' | 'cancelled'
  hashed: number
  total: number
}

/**
 * How an app was installed, which decides where its files are.
 * - desktop: a Windows program registered for uninstall in Settings > Apps.
 * - store: a Microsoft Store (MSIX) package.
 * - app, appstore: a macOS bundle, from the Mac App Store for appstore.
 * - deb, rpm, pacman: a Linux package that installs a menu entry.
 * - flatpak, snap, appimage: a Linux menu entry for an app in that format.
 * - folder: a program in its own folder, found from a Linux menu entry under /opt or a Windows shortcut.
 * - scoop: a Windows app installed with Scoop.
 * - homebrew: a Homebrew formula installed on request, on macOS or Linux.
 * - steam, epic, gog: a game recorded by its launcher (Epic also covers Legendary; GOG covers Heroic).
 */
export type AppSource =
  | 'desktop'
  | 'store'
  | 'app'
  | 'appstore'
  | 'deb'
  | 'rpm'
  | 'pacman'
  | 'flatpak'
  | 'snap'
  | 'appimage'
  | 'folder'
  | 'scoop'
  | 'homebrew'
  | 'steam'
  | 'epic'
  | 'gog'

/**
 * - measured: DiskGrove added up the app's files.
 * - estimated: the installer's own figure, used when the files could not be found.
 * - pending: not measured yet.
 * - unknown: neither is available, or measuring was stopped first.
 */
export type AppSizeKind = 'measured' | 'estimated' | 'pending' | 'unknown'

export interface InstalledApp {
  /** Stable across refreshes of the same app. */
  id: string
  name: string
  version: string
  publisher: string
  source: AppSource
  /** The folder or file the size covers; null for packages whose files are spread over the system. */
  location: string | null
  /** `location` is a folder, which can also be scanned. */
  locationIsFolder: boolean
  /** Bytes in the app's files, null until known. */
  size: number | null
  /** Bytes they occupy on disk, null when only an estimate is known. */
  allocated: number | null
  sizeKind: AppSizeKind
  /** Some files could not be read, so the measured size is too low. */
  partial: boolean
  /** When the app was installed or last updated, in ms; 0 when unknown. */
  installedAt: number
  /** The listed app whose folder holds this one's, so totals count those files once. */
  insideOf: string | null
  /** An icon was found for the app, which `getAppIcon` draws. */
  hasIcon: boolean
}

export interface AppsResult {
  apps: InstalledApp[]
  /** Measuring was stopped, so some sizes are missing. */
  cancelled: boolean
}

export interface AppsProgress extends AppsResult {
  phase: 'listing' | 'measuring' | 'done'
  measured: number
  total: number
}

export interface DiskGroveAPI {
  getMeta(): Promise<AppMeta>
  listDrives(): Promise<DriveInfo[]>
  pickFolder(): Promise<string | null>
  /** The path a scan of `path` will report: its real location when the path runs through a link. */
  resolveScanRoot(path: string): Promise<string>
  startScan(path: string, options?: { followLinks?: boolean; skipHidden?: boolean; exclude?: string[] }): Promise<void>
  cancelScan(): Promise<void>
  getChildren(path: string, sort: SortSpec): Promise<ChildrenResult>
  getNode(path: string): Promise<NodeSummary | null>
  getTopFiles(path: string | null, limit: number): Promise<NodeSummary[]>
  getExtensions(path: string | null): Promise<ExtensionStat[]>
  getAgeStats(path: string | null): Promise<AgeBucket[]>
  /** Files below `path` (the scan root when null) in `group`, largest first. */
  getGroupFiles(group: FileGroup, path: string | null, limit: number): Promise<SearchResult>
  getTreemap(path: string, maxDepth: number, minPercent: number): Promise<TreemapNode | null>
  /** Matches below `path` (the scan root when null), largest first. */
  search(query: string, path: string | null, limit: number): Promise<SearchResult>
  getUnreadable(limit: number): Promise<UnreadableList>
  findDuplicates(path: string | null): Promise<DuplicateGroup[]>
  cancelDuplicates(): Promise<void>
  openPath(path: string): Promise<void>
  revealPath(path: string): Promise<void>
  readFile(path: string, offset: number, length: number): Promise<FileChunk>
  getItemTimes(path: string): Promise<ItemTimes>
  deleteItems(paths: string[], mode: DeleteMode): Promise<DeleteResult>
  exportReport(format: 'csv' | 'json' | 'html'): Promise<string | null>
  /** Installed apps and their sizes: the last list unless `refresh`, joining a listing already running. */
  listApps(refresh: boolean): Promise<AppsResult>
  cancelApps(): Promise<void>
  revealApp(id: string): Promise<void>
  /** The app's icon as an image data URL, or null when it cannot be drawn. */
  getAppIcon(id: string): Promise<string | null>
  onAppsProgress(cb: (p: AppsProgress) => void): () => void
  getSettings(): Promise<AppSettings>
  setSettings(partial: Partial<AppSettings>): Promise<AppSettings>
  onSettingsChanged(cb: (settings: AppSettings) => void): () => void
  onProgress(cb: (p: ScanProgress) => void): () => void
  onComplete(cb: (r: ScanComplete) => void): () => void
  onError(cb: (e: { message: string }) => void): () => void
  onDupProgress(cb: (p: DupProgress) => void): () => void
  minimize(): Promise<void>
  toggleMaximize(): Promise<boolean>
  closeWindow(): Promise<void>
  isMaximized(): Promise<boolean>
  onMaximized(cb: (maximized: boolean) => void): () => void
  isFullScreen(): Promise<boolean>
  onFullScreen(cb: (fullScreen: boolean) => void): () => void
}
