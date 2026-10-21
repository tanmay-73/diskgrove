import type { Stats } from 'node:fs'
import path from 'node:path'
import { fs } from './real-fs'

export interface PathIdentity {
  path: string
  stats: FileIdentity
}

export type FileIdentity = Pick<Stats, 'dev' | 'ino' | 'birthtimeMs' | 'mode' | 'size' | 'mtimeMs'>

/**
 * How closely an item must still match the scan before an action touches it.
 * - read: previews and reveal. The same objects must still sit at every path, but a file may have
 *   new contents and links the scan followed may still be links. Reading changes nothing, and
 *   preview.ts refuses FIFOs and devices on its own.
 * - act: open and hash. The item and every folder above it must be exactly as scanned, with no links.
 * - delete: like act, but the item itself may be a link, since only the link is removed.
 */
export type ItemCheck = 'read' | 'act' | 'delete'

const S_IFMT = 0o170000
const S_IFDIR = 0o040000

export function fileIdentity(stats: Stats): FileIdentity {
  const { dev, ino, birthtimeMs, mode, size, mtimeMs } = stats
  return { dev, ino, birthtimeMs, mode, size, mtimeMs }
}

export async function ancestorIdentities(target: string): Promise<PathIdentity[]> {
  const identities: PathIdentity[] = []
  let current = path.dirname(target)
  while (true) {
    identities.push({ path: current, stats: fileIdentity(await fs.lstat(current)) })
    const parent = path.dirname(current)
    if (parent === current) return identities
    current = parent
  }
}

// Birth time is left out: Linux without statx reports ctime there, which moves with every rename.
function sameObject(before: FileIdentity, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && (before.mode & S_IFMT) === (after.mode & S_IFMT)
}

export function sameEntry(before: FileIdentity, after: Stats): boolean {
  return (
    sameObject(before, after) &&
    before.birthtimeMs === after.birthtimeMs &&
    before.mode === after.mode &&
    ((before.mode & S_IFMT) === S_IFDIR || (before.size === after.size && before.mtimeMs === after.mtimeMs))
  )
}

function stale(target: string, leaf: boolean, problem: string): Error {
  const name = path.basename(target) || target
  const subject = leaf ? `“${name}”` : `The folder “${name}” above this item`
  return new Error(`${subject} ${problem}. Rescan before continuing.`)
}

// Check ancestors too: lstat of the leaf alone follows a replaced parent junction.
// These checks reduce stale-path mistakes but are not an atomic filesystem operation.
export async function assertUnchanged(identities: PathIdentity[], check: ItemCheck): Promise<void> {
  for (let i = identities.length - 1; i >= 0; i--) {
    const { path: target, stats: before } = identities[i]
    const leaf = i === 0
    let current: Stats
    try {
      current = await fs.lstat(target)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') throw stale(target, leaf, 'no longer exists')
      throw error
    }
    if (!sameObject(before, current)) throw stale(target, leaf, 'was replaced after the scan')
    if (check === 'read') continue
    if (current.isSymbolicLink() && !(leaf && check === 'delete')) throw stale(target, leaf, 'is a symbolic link')
    if (!sameEntry(before, current)) throw stale(target, leaf, 'changed after the scan')
  }
}
