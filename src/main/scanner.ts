import { shell } from 'electron'
import { createHash, type Hash } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  ancestorIdentities,
  assertUnchanged,
  sameEntry,
  type FileIdentity,
  type ItemCheck,
  type PathIdentity
} from './file-safety'
import { fs } from './real-fs'
import { forEachConcurrent, walkQueue } from './concurrency'
import { TopK } from './top-k'
import { compileNameQuery } from './name-match'
import { firmlinkDuplicates, virtualDevices } from './mounts'
import { joinPath, NONE, ScanTree } from './scan-tree'
import { setImmediate as yieldToLoop } from 'node:timers/promises'
import type { Dirent, Stats } from 'node:fs'
import { categoryOf } from '@shared/format'
import type {
  AgeBucket,
  ChildrenResult,
  DeleteMode,
  DeleteResult,
  DuplicateGroup,
  DupProgress,
  ExtensionStat,
  FileGroup,
  NodeKind,
  NodeSummary,
  ScanComplete,
  ScanProgress,
  SearchResult,
  SortSpec,
  TreemapNode,
  UnreadableList
} from '@shared/types'

/** A folder waiting to be listed. */
interface PendingDir {
  id: number
  path: string
}

/** Something the scan could not read: the entry `name` of `folder`, or with no name, `folder` itself. */
interface Unreadable {
  folder: number
  name: string | null
  kind: NodeKind
  code: string
}

const CLUSTER = 4096

const SAMPLE_HEAD = 1024 * 1024
const SAMPLE_TAIL = 64 * 1024

const MAX_SEARCH_RESULTS = 5000

function nativePath(p: string): string {
  if (process.platform !== 'win32') return p
  const normalized = path.resolve(p)
  if (normalized.startsWith('\\\\?\\')) return normalized
  // Stat calls on a prefixed volume root (\\?\C:\) fail with EISDIR; roots are short anyway.
  if (path.parse(normalized).root === normalized) return normalized
  if (normalized.startsWith('\\\\')) return `\\\\?\\UNC\\${normalized.slice(2)}`
  return `\\\\?\\${normalized}`
}

function displayPath(p: string): string {
  return p.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '')
}

/**
 * Where a scan of `root` actually happens. A root reached through a link (macOS /tmp and /var, a
 * symlinked home folder, a Windows junction) would fail every later identity check, so it becomes
 * its real location. Paths without links keep their spelling: realpath would also turn a mapped
 * Windows drive into its UNC share.
 */
export async function resolveScanRoot(root: string): Promise<string> {
  const resolved = displayPath(path.resolve(root))
  for (let current = resolved; ; current = path.dirname(current)) {
    if ((await fs.lstat(nativePath(current))).isSymbolicLink()) {
      return displayPath(await fs.realpath(nativePath(resolved)))
    }
    if (path.dirname(current) === current) return resolved
  }
}

function allocatedOf(size: number, stats: Stats): number {
  if (typeof stats.blocks === 'number') {
    // Outside Windows a zero block count is exact: sparse, inline and virtual files occupy nothing.
    if (stats.blocks > 0 || process.platform !== 'win32') return stats.blocks * 512
  }
  if (size <= 0) return 0
  return Math.ceil(size / CLUSTER) * CLUSTER
}

function isLink(entry: Dirent): boolean {
  if (entry.isSymbolicLink()) return true
  const maybe = entry as Dirent & { isJunction?: () => boolean }
  return typeof maybe.isJunction === 'function' && maybe.isJunction()
}

/** The code to report for an item that could not be read, or null when it just went away mid-scan. */
function unreadableCode(error: unknown): string | null {
  const code = (error as NodeJS.ErrnoException | null)?.code
  // Deleted or replaced between being listed and being read: nothing is missing from the totals.
  if (code === 'ENOENT' || code === 'ENOTDIR') return null
  return code ?? 'UNKNOWN'
}

const AGE_DEFS: Array<{ id: string; label: string; maxAgeMs: number | null }> = [
  { id: '1d', label: 'Last 24 hours', maxAgeMs: 24 * 3600 * 1000 },
  { id: '7d', label: 'Last 7 days', maxAgeMs: 7 * 24 * 3600 * 1000 },
  { id: '30d', label: 'Last 30 days', maxAgeMs: 30 * 24 * 3600 * 1000 },
  { id: '90d', label: 'Last 3 months', maxAgeMs: 90 * 24 * 3600 * 1000 },
  { id: '180d', label: 'Last 6 months', maxAgeMs: 180 * 24 * 3600 * 1000 },
  { id: '1y', label: 'Last year', maxAgeMs: 365 * 24 * 3600 * 1000 },
  { id: '2y', label: '1–2 years', maxAgeMs: 2 * 365 * 24 * 3600 * 1000 },
  { id: '5y', label: '2–5 years', maxAgeMs: 5 * 365 * 24 * 3600 * 1000 },
  { id: 'old', label: 'Older than 5 years', maxAgeMs: null }
]

/** Index into AGE_DEFS of the bucket a file last modified `ageMs` ago falls in. */
function ageBucketOf(ageMs: number): number {
  for (let i = 0; i < AGE_DEFS.length; i++) {
    const max = AGE_DEFS[i].maxAgeMs
    if (max === null || ageMs <= max) return i
  }
  return AGE_DEFS.length - 1
}

export class Scanner {
  private tree = new ScanTree('')
  /** Real locations of the folders walked while following links, to stop at cycles. */
  private realPaths = new Map<number, string>()
  private cancelled = false
  /** Whether the last walk was stopped, fixed when it ends so a late cancel cannot mark it. */
  private stoppedEarly = false
  private dupCancelled = false
  private running = false
  private files = 0
  private folders = 0
  private unreadable: Unreadable[] = []
  private bytes = 0
  private allocated = 0
  private currentPath = ''
  private startedAt = 0
  private endedAt = 0
  private rootPath = ''
  private rootAncestors: PathIdentity[] = []
  private virtualDevices = new Set<number>()
  private duplicatePaths = new Set<string>()
  private followLinks = false
  private skipHidden = false
  private progressTimer: NodeJS.Timeout | null = null
  private searchSeq = 0
  private groupSeq = 0
  /** Items visited between yields, so a walk over a huge scan never stalls IPC or the scan itself. */
  private walkSlice = 20000

  onProgress: ((p: ScanProgress) => void) | null = null
  onComplete: ((r: ScanComplete) => void) | null = null
  onDupProgress: ((p: DupProgress) => void) | null = null
  private chain: Promise<void> = Promise.resolve()

  get isRunning(): boolean {
    return this.running
  }

  getRootPath(): string {
    return this.rootPath
  }

  snapshot(): ScanProgress {
    return {
      running: this.running,
      rootPath: this.rootPath,
      files: this.files,
      folders: this.folders,
      bytes: this.bytes,
      allocated: this.allocated,
      unreadable: this.unreadable.length,
      currentPath: this.currentPath,
      elapsedMs: this.startedAt ? (this.endedAt || Date.now()) - this.startedAt : 0
    }
  }

  cancel(): void {
    this.cancelled = true
    this.dupCancelled = true
  }

  cancelDuplicates(): void {
    this.dupCancelled = true
  }

  async start(root: string, options: { followLinks?: boolean; skipHidden?: boolean } = {}): Promise<void> {
    this.cancel()
    const job = () => this.runScan(root, options)
    const p = this.chain.then(job, job)
    this.chain = p.catch(() => undefined)
    return p
  }

  private async runScan(root: string, options: { followLinks?: boolean; skipHidden?: boolean }): Promise<void> {
    this.tree = new ScanTree('')
    this.realPaths.clear()
    this.cancelled = false
    this.stoppedEarly = false
    this.running = true
    this.files = 0
    this.folders = 0
    this.unreadable = []
    this.bytes = 0
    this.allocated = 0
    this.followLinks = Boolean(options.followLinks)
    this.skipHidden = Boolean(options.skipHidden)
    this.rootPath = displayPath(path.resolve(root))
    this.currentPath = this.rootPath
    this.startedAt = Date.now()
    this.endedAt = 0

    let rootStats: Stats
    try {
      this.rootPath = await resolveScanRoot(this.rootPath)
      this.currentPath = this.rootPath
      rootStats = await fs.lstat(nativePath(this.rootPath))
      const target = await fs.stat(nativePath(this.rootPath))
      if (!target.isDirectory()) throw new Error('Select a directory to scan')
      this.rootAncestors = await ancestorIdentities(this.rootPath)
      this.virtualDevices = await virtualDevices()
      // A virtual filesystem chosen as the scan root is still scanned as asked.
      this.virtualDevices.delete(target.dev)
      this.duplicatePaths = await firmlinkDuplicates(this.rootPath)
    } catch (error) {
      this.running = false
      this.endedAt = Date.now()
      throw error
    }
    this.tree = new ScanTree(this.rootPath)
    this.tree.add(path.basename(this.rootPath) || this.rootPath, 'dir', NONE, rootStats)
    this.folders = 1

    this.progressTimer = setInterval(() => this.onProgress?.(this.snapshot()), 200)
    this.onProgress?.(this.snapshot())

    try {
      const workers = Math.min(8, Math.max(2, os.availableParallelism()))
      await walkQueue<PendingDir>(
        { id: 0, path: this.rootPath },
        workers,
        (dir, enqueue) => this.walk(dir, enqueue),
        () => this.cancelled
      )
    } finally {
      if (this.progressTimer) {
        clearInterval(this.progressTimer)
        this.progressTimer = null
      }
      this.realPaths.clear()
      this.stoppedEarly = this.cancelled
      this.running = false
      this.endedAt = Date.now()
      this.currentPath = this.rootPath
      this.onProgress?.(this.snapshot())
    }
  }

  finish(space: { total: number; free: number; volumeRoot?: boolean }): ScanComplete {
    const result: ScanComplete = {
      rootPath: this.rootPath,
      files: this.files,
      folders: this.folders,
      bytes: this.bytes,
      allocated: this.allocated,
      unreadable: this.unreadable.length,
      elapsedMs: (this.endedAt || Date.now()) - this.startedAt,
      freeSpace: space.free,
      totalSpace: space.total,
      isVolumeRoot: space.volumeRoot ?? false,
      cancelled: this.stoppedEarly
    }
    this.onComplete?.(result)
    return result
  }

  private bumpAncestors(id: number, size: number, allocated: number, files: number, folders: number): void {
    this.tree.addToAncestors(id, size, allocated, files, folders)
    this.bytes += size
    this.allocated += allocated
  }

  private noteUnreadable(folder: number, name: string | null, kind: NodeKind, error: unknown): void {
    const code = unreadableCode(error)
    if (code === null) return
    if (name === null) this.tree.markUnreadable(folder)
    this.unreadable.push({ folder, name, kind, code })
  }

  private shouldSkip(name: string): boolean {
    if (name === '.' || name === '..') return true
    if (name === 'System Volume Information') return true
    if (this.skipHidden && name.startsWith('.')) return true
    return false
  }

  private async walk(dir: PendingDir, enqueue: (dir: PendingDir) => void): Promise<void> {
    if (this.cancelled) return
    const tree = this.tree
    this.currentPath = dir.path

    try {
      if (this.followLinks) {
        const real = await fs.realpath(nativePath(dir.path))
        this.realPaths.set(dir.id, real)
        for (let ancestor = tree.parent[dir.id]; ancestor !== NONE; ancestor = tree.parent[ancestor]) {
          if (this.realPaths.get(ancestor) === real) return
        }
      }
      const handle = await fs.opendir(nativePath(dir.path), { bufferSize: 256 })
      const processChunk = async (chunk: Dirent[]) => {
        await forEachConcurrent(chunk, 4, async (entry) => {
          if (this.cancelled) return
          if (this.shouldSkip(entry.name)) return
          if (!this.followLinks && isLink(entry)) return

          const childPath = joinPath(dir.path, entry.name)
          if (this.duplicatePaths.has(childPath)) return
          try {
            const identity = await fs.lstat(nativePath(childPath))
            if (identity.isSymbolicLink() && !this.followLinks) return
            const st = identity.isSymbolicLink() ? await fs.stat(nativePath(childPath)) : identity
            // Mount points of virtual filesystems are listed but their contents are not real data.
            const virtual = this.virtualDevices.has(st.dev)
            if (st.isDirectory()) {
              const child = tree.add(entry.name, 'dir', dir.id, identity)
              tree.setTimes(child, st)
              this.folders++
              this.bumpAncestors(dir.id, 0, 0, 0, 1)
              if (!virtual) enqueue({ id: child, path: childPath })
              return
            }
            if (!st.isFile() || virtual) return

            const size = Number(st.size) || 0
            const alloc = allocatedOf(size, st)
            const file = tree.add(entry.name, 'file', dir.id, identity)
            tree.setTimes(file, st)
            this.files++
            this.bumpAncestors(file, size, alloc, 1, 0)
          } catch (error) {
            this.noteUnreadable(dir.id, entry.name, entry.isDirectory() ? 'dir' : 'file', error)
          }
        })
        await yieldToLoop()
      }
      let chunk: Dirent[] = []
      for await (const entry of handle) {
        if (this.cancelled) break
        chunk.push(entry)
        if (chunk.length === 64) {
          await processChunk(chunk)
          chunk = []
        }
      }
      if (!this.cancelled && chunk.length) await processChunk(chunk)
    } catch (error) {
      this.noteUnreadable(dir.id, null, 'dir', error)
    }
  }

  private getId(target: string | null): number | null {
    if (!target) return this.tree.count ? 0 : null
    return this.tree.find(target)
  }

  private toSummary(
    id: number,
    itemPath = this.tree.pathOf(id),
    parentPath = this.tree.parentPath(id, itemPath)
  ): NodeSummary {
    const tree = this.tree
    const summary: NodeSummary = {
      path: itemPath,
      name: tree.names[id],
      kind: tree.kind(id),
      size: tree.size[id],
      allocated: tree.allocated[id],
      mtime: tree.mtime[id],
      atime: tree.atime[id],
      ctime: tree.ctime[id],
      fileCount: tree.fileCount[id],
      folderCount: tree.folderCount[id],
      ext: tree.ext(id),
      parentPath,
      hasSubdirs: tree.hasSubdirs(id)
    }
    // Set only when true, so exports of large scans do not carry it on every row.
    if (tree.isUnreadable(id)) summary.unreadable = true
    return summary
  }

  getNode(target: string): NodeSummary | null {
    const id = this.getId(target)
    if (id === null) return null
    return this.toSummary(id)
  }

  async assertCurrent(target: string, check: ItemCheck): Promise<void> {
    const id = this.getId(target)
    if (id === null) throw new Error('Not found in scan results')
    await this.assertCurrentId(id, check)
  }

  private async assertCurrentId(id: number, check: ItemCheck): Promise<void> {
    const tree = this.tree
    const identities: PathIdentity[] = []
    let item = id
    let itemPath: string | null = tree.pathOf(id)
    while (itemPath !== null) {
      identities.push({ path: nativePath(itemPath), stats: tree.identity(item) })
      itemPath = tree.parentPath(item, itemPath)
      item = tree.parent[item]
    }
    await assertUnchanged([...identities, ...this.rootAncestors], check)
  }

  getChildren(target: string, sort: SortSpec): ChildrenResult {
    const id = this.getId(target)
    if (id === null) return { dirs: [], files: [], parent: null }
    const tree = this.tree
    const folder = tree.pathOf(id)
    const dirs: NodeSummary[] = []
    const files: NodeSummary[] = []
    for (const child of tree.children(id)) {
      const summary = this.toSummary(child, joinPath(folder, tree.names[child]), folder)
      if (summary.kind === 'dir') dirs.push(summary)
      else files.push(summary)
    }
    const cmp = this.comparer(sort)
    dirs.sort(cmp)
    files.sort(cmp)
    return { dirs, files, parent: this.toSummary(id, folder) }
  }

  private comparer(sort: SortSpec) {
    const dir = sort.dir === 'asc' ? 1 : -1
    return (a: NodeSummary, b: NodeSummary) => {
      let av: number | string = 0
      let bv: number | string = 0
      switch (sort.key) {
        case 'name':
          av = a.name.toLowerCase()
          bv = b.name.toLowerCase()
          break
        case 'allocated':
          av = a.allocated
          bv = b.allocated
          break
        case 'files':
          av = a.fileCount
          bv = b.fileCount
          break
        case 'folders':
          av = a.folderCount
          bv = b.folderCount
          break
        case 'mtime':
          av = a.mtime
          bv = b.mtime
          break
        case 'percent':
        case 'size':
        default:
          av = a.size
          bv = b.size
      }
      if (av < bv) return -1 * dir
      if (av > bv) return 1 * dir
      return a.name.localeCompare(b.name)
    }
  }

  /**
   * Visits every item below `id`, pausing every `walkSlice` items so IPC and a running scan keep
   * going. Returns false, having stopped early, when `stop` says so or a rescan replaced the tree.
   */
  private async eachBelow(
    id: number,
    visit: (item: number) => void,
    stop: () => boolean = () => false
  ): Promise<boolean> {
    const tree = this.tree
    const stack: number[] = []
    tree.pushChildren(id, stack)
    let visited = 0
    while (stack.length) {
      const item = stack.pop()!
      // Deleted while the walk was paused.
      if (tree.isRemoved(item)) continue
      visit(item)
      if (tree.isDir(item)) tree.pushChildren(item, stack)
      if (++visited % this.walkSlice === 0) {
        await yieldToLoop()
        if (tree !== this.tree || stop()) return false
      }
    }
    return true
  }

  async getTopFiles(target: string | null, limit: number): Promise<NodeSummary[]> {
    const id = this.getId(target)
    if (id === null) return []
    const tree = this.tree
    const best = new TopK<number>(Math.max(1, Math.min(limit, 5000)), (a, b) => tree.size[b] - tree.size[a] || a - b)
    const done = await this.eachBelow(id, (item) => {
      if (!tree.isDir(item)) best.push(item)
    })
    if (!done) return []
    return best
      .sorted()
      .filter((item) => !tree.isRemoved(item))
      .map((item) => this.toSummary(item))
  }

  async getExtensions(target: string | null): Promise<ExtensionStat[]> {
    const id = this.getId(target)
    if (id === null) return []
    const tree = this.tree
    const map = new Map<number, { count: number; size: number }>()
    let total = 0
    const done = await this.eachBelow(id, (item) => {
      if (tree.isDir(item)) return
      const ext = tree.extId(item)
      const cur = map.get(ext) ?? { count: 0, size: 0 }
      cur.count++
      cur.size += tree.size[item]
      map.set(ext, cur)
      total += tree.size[item]
    })
    if (!done) return []
    return [...map.entries()]
      .map(([index, v]) => {
        const ext = tree.extName(index)
        return {
          ext,
          category: categoryOf(ext),
          count: v.count,
          size: v.size,
          percent: total ? (v.size / total) * 100 : 0
        }
      })
      .sort((a, b) => b.size - a.size || (a.ext < b.ext ? -1 : 1))
  }

  async getAgeStats(target: string | null): Promise<AgeBucket[]> {
    const id = this.getId(target)
    if (id === null) return []
    const tree = this.tree
    const now = Date.now()
    const buckets = AGE_DEFS.map((d) => ({ ...d, count: 0, size: 0 }))
    let total = 0
    const done = await this.eachBelow(id, (item) => {
      if (tree.isDir(item)) return
      const idx = ageBucketOf(Math.max(0, now - (tree.mtime[item] || now)))
      buckets[idx].count++
      buckets[idx].size += tree.size[item]
      total += tree.size[item]
    })
    if (!done) return []
    return buckets.map((b) => ({
      id: b.id,
      label: b.label,
      count: b.count,
      size: b.size,
      percent: total ? (b.size / total) * 100 : 0
    }))
  }

  async getGroupFiles(group: FileGroup, target: string | null, limit: number): Promise<SearchResult> {
    const seq = ++this.groupSeq
    const tree = this.tree
    const id = this.getId(target)
    const root = id === null ? (target ?? this.rootPath) : tree.pathOf(id)
    if (id === null) return { root, hits: [], total: 0 }
    let inGroup: (item: number) => boolean
    if (group.by === 'ext') {
      const index = tree.extIndexOf(group.ext)
      if (index === null) return { root, hits: [], total: 0 }
      inGroup = (item) => tree.extId(item) === index
    } else {
      const bucket = AGE_DEFS.findIndex((d) => d.id === group.id)
      if (bucket === -1) return { root, hits: [], total: 0 }
      const now = Date.now()
      inGroup = (item) => ageBucketOf(Math.max(0, now - (tree.mtime[item] || now))) === bucket
    }

    const best = new TopK<number>(
      Math.max(1, Math.min(limit, MAX_SEARCH_RESULTS)),
      (a, b) => tree.size[b] - tree.size[a] || a - b
    )
    let total = 0
    const done = await this.eachBelow(
      id,
      (item) => {
        if (tree.isDir(item) || !inGroup(item)) return
        total++
        best.push(item)
      },
      () => seq !== this.groupSeq
    )
    if (!done) return { root, hits: [], total: 0 }
    const ranked = best.sorted()
    // Items deleted while the walk was paused are no longer part of the scan.
    const hits = ranked.filter((item) => !tree.isRemoved(item))
    return { root, hits: hits.map((item) => this.toSummary(item)), total: total - (ranked.length - hits.length) }
  }

  getTreemap(target: string, maxDepth: number, minPercent: number): TreemapNode | null {
    const id = this.getId(target)
    if (id === null) return null
    const tree = this.tree
    const minSize = Math.max(0, tree.size[id] * (Math.max(0, minPercent) / 100))
    const maxChildren = 48

    const build = (item: number, itemPath: string, depth: number): TreemapNode => {
      const size = tree.size[item]
      const result: TreemapNode = {
        path: itemPath,
        name: tree.names[item],
        kind: tree.kind(item),
        value: Math.max(0, size),
        ext: tree.ext(item)
      }
      if (!tree.isDir(item) || depth >= maxDepth || size <= 0) return result

      // Rank folders and files together so a huge file is never dropped in
      // favour of many small folders.
      const candidates: number[] = []
      for (const child of tree.children(item)) {
        if (tree.size[child] > 0 && tree.size[child] >= minSize) candidates.push(child)
      }
      candidates.sort((a, b) => tree.size[b] - tree.size[a])
      const picked = candidates.slice(0, maxChildren)

      const children = picked.map((child) => build(child, joinPath(itemPath, tree.names[child]), depth + 1))
      const shown = picked.reduce((sum, child) => sum + tree.size[child], 0)
      // Always account for the remainder so tile areas stay proportional to
      // real sizes; the renderer skips tiles too small to draw.
      const leftover = Math.max(0, size - shown)
      if (leftover > 0 && children.length) {
        children.push({
          path: `${itemPath}::__other__`,
          name: 'Other',
          kind: 'file',
          value: leftover,
          ext: ''
        })
      }
      if (children.length) result.children = children
      return result
    }

    return build(id, tree.pathOf(id), 0)
  }

  /**
   * Names below `target` (the scan root when null) that match `query`, largest first. The search runs
   * in slices; a newer search supersedes it, and a superseded search returns no hits.
   */
  async search(query: string, target: string | null, limit: number): Promise<SearchResult> {
    const seq = ++this.searchSeq
    const tree = this.tree
    const id = this.getId(target)
    const root = id === null ? (target ?? this.rootPath) : tree.pathOf(id)
    const matches = compileNameQuery(query)
    if (id === null || !matches) return { root, hits: [], total: 0 }

    const best = new TopK<number>(
      Math.max(1, Math.min(limit, MAX_SEARCH_RESULTS)),
      (a, b) => tree.size[b] - tree.size[a] || a - b
    )
    let total = 0
    // The folder itself is not a result, only what it contains.
    const done = await this.eachBelow(
      id,
      (item) => {
        if (matches(tree.names[item])) {
          total++
          best.push(item)
        }
      },
      () => seq !== this.searchSeq
    )
    if (!done) return { root, hits: [], total: 0 }
    const ranked = best.sorted()
    // Items deleted while the search was paused are no longer part of the scan.
    const hits = ranked.filter((item) => !tree.isRemoved(item))
    return { root, hits: hits.map((item) => this.toSummary(item)), total: total - (ranked.length - hits.length) }
  }

  /** What the scan could not read, in the order it came up, with at most `limit` items listed. */
  getUnreadable(limit: number): UnreadableList {
    const tree = this.tree
    let folders = 0
    for (const item of this.unreadable) if (item.kind === 'dir') folders++
    const items = this.unreadable.slice(0, limit).map(({ folder, name, kind, code }) => {
      const folderPath = tree.pathOf(folder)
      return { path: name === null ? folderPath : joinPath(folderPath, name), kind, folder: folderPath, code }
    })
    return { folders, files: this.unreadable.length - folders, items }
  }

  /**
   * The scanned folder that lists `target`, when `target` is an entry the scan could not read. Such
   * entries are not part of the scan, but their folder is.
   */
  unreadableParent(target: string): string | null {
    const folder = this.tree.find(path.dirname(target))
    const name = path.basename(target)
    if (folder === null || !this.unreadable.some((item) => item.folder === folder && item.name === name)) return null
    return this.tree.pathOf(folder)
  }

  async findDuplicates(target: string | null): Promise<DuplicateGroup[]> {
    const id = this.getId(target)
    if (id === null) return []
    const tree = this.tree
    this.dupCancelled = false
    const stopped = () => this.dupCancelled
    this.onDupProgress?.({ phase: 'grouping', hashed: 0, total: 0 })

    const bySize = new Map<number, number[]>()
    const grouped = await this.eachBelow(
      id,
      (item) => {
        const size = tree.size[item]
        if (tree.isDir(item) || size <= 0) return
        const list = bySize.get(size)
        if (list) list.push(item)
        else bySize.set(size, [item])
      },
      stopped
    )
    if (!grouped) {
      this.onDupProgress?.({ phase: 'cancelled', hashed: 0, total: 0 })
      return []
    }

    const candidates: number[] = []
    for (const group of bySize.values()) {
      if (group.length > 1) for (const file of group) candidates.push(file)
    }

    let hashed = 0
    let total = candidates.length
    const report = () => this.onDupProgress?.({ phase: 'hashing', hashed, total })
    report()

    const hashAll = async (files: number[], mode: HashMode): Promise<Map<string, number[]>> => {
      const groups = new Map<string, number[]>()
      await forEachConcurrent(files, 6, async (file) => {
        if (stopped()) return
        try {
          await this.assertCurrentId(file, 'act')
          const size = tree.size[file]
          const key = `${size}:${await hashFile(tree.pathOf(file), size, mode, tree.identity(file), stopped)}`
          const list = groups.get(key)
          if (list) list.push(file)
          else groups.set(key, [file])
        } catch {
          /* unreadable */
        } finally {
          hashed++
          if (hashed % 8 === 0 || hashed === total) report()
        }
      })
      return groups
    }

    // Files up to SAMPLE_HEAD are hashed in full during sampling.
    const sampled = await hashAll(candidates, 'sample')

    // Larger matches need a full hash before they can be reported as duplicates.
    const confirmed: Array<[string, number[]]> = []
    const needFull: number[] = []
    for (const [key, list] of sampled) {
      if (list.length < 2) continue
      if (tree.size[list[0]] <= SAMPLE_HEAD) confirmed.push([key, list])
      else for (const file of list) needFull.push(file)
    }
    if (needFull.length && !stopped()) {
      total += needFull.length
      report()
      const full = await hashAll(needFull, 'full')
      for (const [key, list] of full) {
        if (list.length >= 2) confirmed.push([key, list])
      }
    }

    const groups: DuplicateGroup[] = []
    for (const [key, files] of confirmed) {
      const size = tree.size[files[0]]
      groups.push({
        hash: key.slice(key.indexOf(':') + 1),
        size,
        count: files.length,
        wasted: size * (files.length - 1),
        files: files.map((f) => ({ path: tree.pathOf(f), name: tree.names[f], mtime: tree.mtime[f] }))
      })
    }
    groups.sort((a, b) => b.wasted - a.wasted)
    // A stopped search still reports the matches it fully verified before stopping.
    if (stopped()) this.onDupProgress?.({ phase: 'cancelled', hashed, total })
    else this.onDupProgress?.({ phase: 'done', hashed: total, total })
    return groups
  }

  flatten(): NodeSummary[] {
    return [...this.summaries()]
  }

  *summaries(): Generator<NodeSummary> {
    const tree = this.tree
    // A folder's id is smaller than its items', so its path is known by the time they come up.
    const folders = new Map<number, string>()
    for (let id = 0; id < tree.count; id++) {
      if (tree.isRemoved(id)) continue
      const parent = tree.parent[id]
      const parentPath = parent === NONE ? null : folders.get(parent)!
      const itemPath = parentPath === null ? tree.rootPath : joinPath(parentPath, tree.names[id])
      if (tree.isDir(id)) folders.set(id, itemPath)
      yield this.toSummary(id, itemPath, parentPath)
    }
  }

  async deleteMany(targets: string[], mode: DeleteMode): Promise<DeleteResult> {
    const result: DeleteResult = { mode, deleted: [], failed: [] }
    for (const target of targets) {
      const outcome = await this.deletePath(target, mode)
      if (outcome.ok) result.deleted.push(target)
      else result.failed.push({ path: target, error: outcome.error ?? 'Unknown error' })
    }
    return result
  }

  async deletePath(target: string, mode: DeleteMode): Promise<{ ok: boolean; error?: string }> {
    if (this.running) return { ok: false, error: 'Wait for the scan to finish before deleting items' }
    const id = this.getId(target)
    if (id === null) return { ok: false, error: 'Not found in scan results' }
    if (id === 0) return { ok: false, error: 'Cannot delete the scan root' }
    const tree = this.tree
    const itemPath = tree.pathOf(id)
    const parsed = path.parse(itemPath)
    if (!parsed.base || parsed.root === itemPath) return { ok: false, error: 'Refusing to delete a filesystem root' }

    const native = nativePath(itemPath)
    try {
      await this.assertCurrentId(id, 'delete')
      const st = await fs.lstat(native)
      const isLinkNow = st.isSymbolicLink()
      const isDirNow = !isLinkNow && st.isDirectory()

      if (mode === 'trash') {
        await shell.trashItem(itemPath)
      } else if (isLinkNow) {
        await removeLink(native)
      } else if (isDirNow) {
        await fs.rm(native, { recursive: true, force: false })
      } else {
        await fs.unlink(native)
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }

    tree.remove(id)
    this.unreadable = this.unreadable.filter((item) => !tree.isRemoved(item.folder))
    this.bytes = tree.size[0]
    this.allocated = tree.allocated[0]
    this.files = tree.fileCount[0]
    this.folders = tree.folderCount[0] + 1
    return { ok: true }
  }
}

async function removeLink(native: string): Promise<void> {
  try {
    await fs.unlink(native)
  } catch (err) {
    // Windows reports directory symlinks and junctions as directories: rmdir removes just the link.
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'EPERM' && code !== 'EISDIR') throw err
    await fs.rmdir(native)
  }
}

type HashMode = 'sample' | 'full'

async function digestRange(
  hash: Hash,
  file: FileHandle,
  start: number,
  end: number,
  stopped: () => boolean
): Promise<void> {
  const buffer = Buffer.allocUnsafe(64 * 1024)
  let position = start
  while (position < end) {
    if (stopped()) throw new Error('Duplicate search stopped')
    const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, end - position), position)
    if (!bytesRead) throw new Error('File was truncated while hashing')
    hash.update(buffer.subarray(0, bytesRead))
    position += bytesRead
  }
}

async function hashFile(
  filePath: string,
  size: number,
  mode: HashMode,
  identity: FileIdentity,
  stopped: () => boolean
): Promise<string> {
  const hash = createHash('sha256')
  const file = await fs.open(nativePath(filePath), 'r')
  try {
    if (!sameEntry(identity, await file.stat())) throw new Error('File changed since the scan')
    if (mode === 'full' || size <= SAMPLE_HEAD) {
      await digestRange(hash, file, 0, size, stopped)
    } else {
      await digestRange(hash, file, 0, SAMPLE_HEAD, stopped)
      await digestRange(hash, file, Math.max(0, size - SAMPLE_TAIL), size, stopped)
    }
    if (!sameEntry(identity, await file.stat())) throw new Error('File changed while hashing')
    hash.update(String(size))
    return hash.digest('hex')
  } finally {
    await file.close()
  }
}
