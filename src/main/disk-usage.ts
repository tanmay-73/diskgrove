import type { Dirent, Stats } from 'node:fs'
import path from 'node:path'
import { forEachConcurrent, walkQueue } from './concurrency'
import { fs } from './real-fs'

const CLUSTER = 4096

/** The path to hand to the filesystem: Windows paths get the `\\?\` prefix so long paths work. */
export function nativePath(p: string): string {
  if (process.platform !== 'win32') return p
  const normalized = path.resolve(p)
  if (normalized.startsWith('\\\\?\\')) return normalized
  // Stat calls on a prefixed volume root (\\?\C:\) fail with EISDIR; roots are short anyway.
  if (path.parse(normalized).root === normalized) return normalized
  if (normalized.startsWith('\\\\')) return `\\\\?\\UNC\\${normalized.slice(2)}`
  return `\\\\?\\${normalized}`
}

/** The path to show: `nativePath` without its prefix. */
export function displayPath(p: string): string {
  return p.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '')
}

/** Space a file takes on disk: its block count where the filesystem reports one, else whole 4 KiB clusters. */
export function allocatedOf(size: number, stats: Stats): number {
  if (typeof stats.blocks === 'number') {
    // Outside Windows a zero block count is exact: sparse, inline and virtual files occupy nothing.
    if (stats.blocks > 0 || process.platform !== 'win32') return stats.blocks * 512
  }
  if (size <= 0) return 0
  return Math.ceil(size / CLUSTER) * CLUSTER
}

/** Symbolic links and Windows junctions. */
export function isLink(entry: Dirent): boolean {
  if (entry.isSymbolicLink()) return true
  const maybe = entry as Dirent & { isJunction?: () => boolean }
  return typeof maybe.isJunction === 'function' && maybe.isJunction()
}

export interface Usage {
  /** Bytes in the files: what a file manager calls the size. */
  bytes: number
  /** Bytes the files occupy on disk. */
  allocated: number
  files: number
  /** Something could not be read, so the totals are too low. */
  partial: boolean
}

/** Adds up regular files, counting a file reached through several hard links once. */
class UsageCounter {
  readonly usage: Usage = { bytes: 0, allocated: 0, files: 0, partial: false }
  private seen = new Set<string>()

  add(stats: Stats): void {
    if (!stats.isFile()) return
    if (stats.nlink > 1) {
      const key = `${stats.dev}:${stats.ino}`
      if (this.seen.has(key)) return
      this.seen.add(key)
    }
    const size = Number(stats.size) || 0
    this.usage.bytes += size
    this.usage.allocated += allocatedOf(size, stats)
    this.usage.files++
  }

  fail(error: unknown): void {
    // Deleted while being measured: nothing is missing from the totals.
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') this.usage.partial = true
  }
}

/**
 * Size of everything below `folder`. Links and junctions inside it are not followed, so nothing
 * outside the folder is counted; `folder` itself may be one, as for an app moved to another drive.
 * Throws when `folder` is missing or not a folder; returns null when cancelled.
 */
export async function measureFolder(folder: string, cancelled: () => boolean): Promise<Usage | null> {
  const root = await fs.stat(nativePath(folder))
  if (!root.isDirectory()) throw Object.assign(new Error(`Not a folder: ${folder}`), { code: 'ENOTDIR' })
  const counter = new UsageCounter()
  await walkQueue(
    folder,
    4,
    async (dir, enqueue) => {
      let entries: Dirent[]
      try {
        entries = await fs.readdir(nativePath(dir), { withFileTypes: true })
      } catch (error) {
        counter.fail(error)
        return
      }
      await forEachConcurrent(entries, 8, async (entry) => {
        if (cancelled() || isLink(entry)) return
        const child = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          enqueue(child)
          return
        }
        try {
          counter.add(await fs.lstat(nativePath(child)))
        } catch (error) {
          counter.fail(error)
        }
      })
    },
    cancelled
  )
  return cancelled() ? null : counter.usage
}

/** Size of the regular files among `files`. Folders, links and missing paths count nothing. */
export async function measureFiles(files: Iterable<string>, cancelled: () => boolean): Promise<Usage | null> {
  const counter = new UsageCounter()
  await forEachConcurrent(files, 16, async (file) => {
    if (cancelled()) return
    try {
      counter.add(await fs.lstat(nativePath(file)))
    } catch (error) {
      counter.fail(error)
    }
  })
  return cancelled() ? null : counter.usage
}
