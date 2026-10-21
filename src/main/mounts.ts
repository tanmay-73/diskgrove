import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { forEachConcurrent } from './concurrency'
import { fs } from './real-fs'

const execFileAsync = promisify(execFile)

// Filesystems the kernel synthesises on demand: their entries describe kernel state rather than
// stored data and report arbitrary sizes (/proc/kcore claims the whole address space).
// Memory-backed (tmpfs, devtmpfs, hugetlbfs) and automount (autofs) types hold or lead to real data.
const VIRTUAL_FS = new Set([
  'proc',
  'sysfs',
  'devpts',
  'cgroup',
  'cgroup2',
  'debugfs',
  'tracefs',
  'securityfs',
  'pstore',
  'bpf',
  'nsfs',
  'fusectl',
  'mqueue',
  'configfs',
  'rpc_pipefs',
  'binfmt_misc',
  'efivarfs'
])

// Matches the st_dev encoding glibc and musl use, which is what fs.stat reports.
function makedev(major: number, minor: number): number {
  return (
    (major % 4096) * 2 ** 8 + (minor % 256) + Math.floor(minor / 256) * 2 ** 20 + Math.floor(major / 4096) * 2 ** 44
  )
}

/** Device numbers of the virtual filesystems listed in a /proc/self/mountinfo table. */
export function parseVirtualDevices(mountinfo: string): Set<number> {
  const devices = new Set<number>()
  for (const line of mountinfo.split('\n')) {
    // Fields before the separator are space-escaped, so the first " - " always precedes the type.
    const separator = line.indexOf(' - ')
    if (separator === -1) continue
    const fsType = line.slice(separator + 3).split(' ', 1)[0]
    if (!VIRTUAL_FS.has(fsType)) continue
    const device = /^\d+ \d+ (\d+):(\d+) /.exec(line)
    if (device) devices.add(makedev(Number(device[1]), Number(device[2])))
  }
  return devices
}

// macOS has no mount table to read without spawning a process, and devfs is its one virtual
// filesystem with entries: /dev/fd mirrors whatever this process holds open, scanned folders included.
async function devfsDevice(): Promise<Set<number>> {
  try {
    const [dev, root] = await Promise.all([fs.stat('/dev'), fs.stat('/')])
    return dev.dev === root.dev ? new Set() : new Set([dev.dev])
  } catch {
    return new Set()
  }
}

export async function virtualDevices(): Promise<Set<number>> {
  if (process.platform === 'darwin') return devfsDevice()
  if (process.platform !== 'linux') return new Set()
  try {
    return parseVirtualDevices(await fs.readFile('/proc/self/mountinfo', 'utf8'))
  } catch {
    return new Set()
  }
}

function unescapeMountPath(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)))
}

/** Mount points listed in a /proc/self/mountinfo table. */
export function parseMountPoints(mountinfo: string): Set<string> {
  const points = new Set<string>()
  for (const line of mountinfo.split('\n')) {
    const fields = line.split(' ')
    if (fields.length < 5 || !/^\d+$/.test(fields[0])) continue
    points.add(unescapeMountPath(fields[4]))
  }
  return points
}

/** Mount points listed by macOS `mount`, one "<device> on <path> (<type>, <flags>)" per line. */
export function parseMacMountPoints(output: string): Set<string> {
  const points = new Set<string>()
  for (const line of output.split('\n')) {
    // Devices can hold spaces ("map auto_home"), so anchor on the first " on /" and the closing flags.
    const match = / on (\/.*) \([^()]*\)$/.exec(line.trimEnd())
    if (match) points.add(match[1])
  }
  return points
}

async function mountPoints(): Promise<Set<string> | null> {
  try {
    if (process.platform === 'linux') return parseMountPoints(await fs.readFile('/proc/self/mountinfo', 'utf8'))
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('/sbin/mount', [], { timeout: 5000, maxBuffer: 1024 * 1024 })
      return parseMacMountPoints(stdout)
    }
  } catch {
    /* no mount table: fall back to device numbers */
  }
  return null
}

/** System-volume paths in a macOS firmlink table: folders grafted from the data volume, not mounts. */
export function firmlinkSources(table: string): Set<string> {
  const sources = new Set<string>()
  for (const line of table.split('\n')) {
    const source = line.trim().split('\t')[0]
    if (source?.startsWith('/')) sources.add(source)
  }
  return sources
}

/**
 * True for a drive root (`C:\`, `/`) or a folder another volume is mounted on, so the free
 * space statfs reports belongs to it rather than to some volume further up.
 */
export async function isVolumeRoot(target: string): Promise<boolean> {
  let resolved = path.resolve(target)
  if (path.dirname(resolved) === resolved) return true
  if (process.platform !== 'win32') {
    // /Volumes/Macintosh HD links to /, and /tmp on macOS lives under /private.
    try {
      resolved = await fs.realpath(resolved)
    } catch {
      return false
    }
    if (resolved === '/') return true
  }
  // The mount table beats device numbers: btrfs subvolumes get their own device without being
  // mounted, bind mounts share their source's, and on macOS the APFS volumes of one container
  // need not differ from the folder they are mounted on.
  const points = await mountPoints()
  if (points) return points.has(resolved)
  try {
    const [self, above] = await Promise.all([fs.stat(resolved), fs.stat(path.dirname(resolved))])
    if (self.dev === above.dev) return false
    if (process.platform !== 'darwin') return true
    // /Users, /Applications and friends sit on the data volume but are firmlinks, not mounts.
    try {
      return !firmlinkSources(await fs.readFile(MAC_FIRMLINKS, 'utf8')).has(resolved)
    } catch {
      return true
    }
  } catch {
    return false
  }
}

const MAC_DATA_VOLUME = '/System/Volumes/Data'
const MAC_FIRMLINKS = '/usr/share/firmlinks'

function isWithin(root: string, target: string): boolean {
  return root === '/' || target === root || target.startsWith(`${root}/`)
}

/**
 * Firmlinks from a macOS firmlink table whose two ends both fall inside a scan of `root`.
 * Each line maps a path on the system volume to a folder relative to the data volume.
 */
export function firmlinkPairs(table: string, root: string): Array<{ source: string; target: string }> {
  const pairs: Array<{ source: string; target: string }> = []
  for (const line of table.split('\n')) {
    const [source, relative] = line.trim().split('\t')
    if (!source?.startsWith('/') || !relative) continue
    const target = path.posix.join(MAC_DATA_VOLUME, relative)
    if (isWithin(root, source) && isWithin(root, target)) pairs.push({ source, target })
  }
  return pairs
}

/**
 * macOS grafts data-volume folders such as /Users onto the system volume, so a scan that covers
 * both would count them twice. Returns the data-volume copies to leave out, as paths under `root`.
 */
export async function firmlinkDuplicates(root: string): Promise<Set<string>> {
  const duplicates = new Set<string>()
  if (process.platform !== 'darwin') return duplicates
  try {
    const real = await fs.realpath(root)
    const pairs = firmlinkPairs(await fs.readFile(MAC_FIRMLINKS, 'utf8'), real)
    await forEachConcurrent(pairs, 8, async ({ source, target }) => {
      try {
        const [a, b] = await Promise.all([fs.lstat(source, { bigint: true }), fs.lstat(target, { bigint: true })])
        // Only a folder proven to be the same one is dropped.
        if (a.dev === b.dev && a.ino === b.ino) duplicates.add(path.join(root, path.relative(real, target)))
      } catch {
        /* not present on this system */
      }
    })
  } catch {
    /* no firmlink table: nothing to leave out */
  }
  return duplicates
}
