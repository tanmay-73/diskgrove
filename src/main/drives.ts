import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { DriveInfo, DriveKind } from '@shared/types'
import { forEachConcurrent } from './concurrency'
import { isVolumeRoot } from './mounts'
import { fs } from './real-fs'

const execFileAsync = promisify(execFile)

function kindFromWinType(t: number): DriveKind {
  switch (t) {
    case 2:
      return 'removable'
    case 3:
      return 'fixed'
    case 4:
      return 'network'
    case 5:
      return 'optical'
    default:
      return 'unknown'
  }
}

async function fromStatfs(mount: string, fallback: Partial<DriveInfo> = {}): Promise<DriveInfo | null> {
  try {
    const s = await fs.statfs(mount)
    const bsize = Number(s.bsize)
    const total = Number(s.blocks) * bsize
    const free = Number(s.bavail) * bsize
    if (!Number.isFinite(total) || total <= 0) return null
    return {
      path: mount,
      label: fallback.label ?? mount,
      name: fallback.name ?? '',
      fsType: fallback.fsType ?? '',
      total,
      free,
      used: Math.max(0, total - free),
      kind: fallback.kind ?? 'fixed'
    }
  } catch {
    return null
  }
}

interface WinDisk {
  DeviceID?: unknown
  VolumeName?: unknown
  FileSystem?: unknown
  DriveType?: unknown
  Size?: unknown
  FreeSpace?: unknown
  DriveLetter?: unknown
  Label?: unknown
  Capacity?: unknown
}

interface WindowsMounts {
  Logical?: WinDisk[]
  Volumes?: WinDisk[]
  Mounts?: Array<{ Volume?: unknown; Path?: unknown }>
}

export function parseWindowsDrives(data: WindowsMounts): DriveInfo[] {
  const drives = new Map<string, DriveInfo>()
  const mounts = new Map<string, string[]>()
  for (const entry of Array.isArray(data.Mounts) ? data.Mounts : []) {
    if (!entry) continue
    const volume = text(entry.Volume)
    const mount = text(entry.Path)
    if (!/^[A-Za-z]:\\/.test(mount) || mount.includes('\0')) continue
    const paths = mounts.get(volume) ?? []
    paths.push(mount)
    mounts.set(volume, paths)
  }
  const add = (row: WinDisk, mount: string, volume: boolean) => {
    const total = Number(volume ? row.Capacity : row.Size)
    const free = Number(row.FreeSpace)
    if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(free) || free < 0) return
    drives.set(mount.toLowerCase(), {
      path: mount,
      label: mount.replace(/\\$/, ''),
      name: text(volume ? row.Label : row.VolumeName).trim(),
      fsType: text(row.FileSystem),
      total,
      free: Math.min(free, total),
      used: Math.max(0, total - free),
      kind: kindFromWinType(Number(row.DriveType))
    })
  }
  for (const row of Array.isArray(data.Logical) ? data.Logical : []) {
    if (row && /^[A-Za-z]:$/.test(text(row.DeviceID))) add(row, `${row.DeviceID}\\`, false)
  }
  for (const row of Array.isArray(data.Volumes) ? data.Volumes : []) {
    if (!row) continue
    const letter = text(row.DriveLetter)
    const mount = /^[A-Za-z]:$/.test(letter) ? `${letter}\\` : mounts.get(text(row.DeviceID))?.[0]
    if (mount && !drives.has(mount.toLowerCase())) add(row, mount, true)
  }
  return [...drives.values()].sort((a, b) => a.path.localeCompare(b.path))
}

const WINDOWS_DRIVES_COMMAND = [
  '$logical = @(Get-CimInstance Win32_LogicalDisk -ErrorAction Stop | Select-Object DeviceID,VolumeName,FileSystem,DriveType,Size,FreeSpace)',
  '$volumes = @(Get-CimInstance Win32_Volume -ErrorAction SilentlyContinue | Select-Object DeviceID,DriveLetter,Label,FileSystem,DriveType,Capacity,FreeSpace)',
  '$mounts = @(Get-CimInstance Win32_MountPoint -ErrorAction SilentlyContinue | ForEach-Object { @{ Volume = $_.Volume.DeviceID; Path = $_.Directory.Name } })',
  '@{ Logical = $logical; Volumes = $volumes; Mounts = $mounts } | ConvertTo-Json -Depth 4 -Compress'
].join('; ')

// Avoid resolving powershell.exe through PATH.
function powershellPath(): string {
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

async function listWindows(): Promise<DriveInfo[]> {
  try {
    const { stdout } = await execFileAsync(
      powershellPath(),
      ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_DRIVES_COMMAND],
      { windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 }
    )
    const parsed: unknown = JSON.parse(stdout || '{}')
    const drives = parseWindowsDrives(parsed && typeof parsed === 'object' ? parsed : {})
    if (drives.length) return drives
  } catch {
    /* fall through to letter scan */
  }

  const drives: DriveInfo[] = []
  await forEachConcurrent('ABCDEFGHIJKLMNOPQRSTUVWXYZ', 8, async (letter) => {
    const mount = `${letter}:\\`
    try {
      await fs.access(mount)
      const info = await fromStatfs(mount, { label: `${letter}:`, kind: 'fixed' })
      if (info) drives.push(info)
    } catch {
      /* not present */
    }
  })
  return drives.sort((a, b) => a.path.localeCompare(b.path))
}

async function listMac(): Promise<DriveInfo[]> {
  const mounts = ['/']
  try {
    // /Volumes also holds a link to the startup volume and can hold plain folders: keep mount points only.
    const [root, volumes] = await Promise.all([fs.stat('/'), fs.stat('/Volumes')])
    const entries = await fs.readdir('/Volumes', { withFileTypes: true })
    await forEachConcurrent(entries, 8, async (e) => {
      if (e.name.startsWith('.')) return
      const mount = path.join('/Volumes', e.name)
      try {
        const { dev } = await fs.stat(mount)
        if (dev !== root.dev && dev !== volumes.dev) mounts.push(mount)
      } catch {
        /* unreadable */
      }
    })
  } catch {
    /* ignore */
  }
  const drives: DriveInfo[] = []
  await forEachConcurrent(mounts, 8, async (mount) => {
    const info = await fromStatfs(mount, {
      label: mount === '/' ? 'Macintosh HD' : path.basename(mount),
      name: mount === '/' ? 'System' : path.basename(mount),
      kind: 'fixed'
    })
    if (info) drives.push(info)
  })
  return drives.sort((a, b) => a.path.localeCompare(b.path))
}

const PSEUDO_FS = new Set([
  'proc',
  'sysfs',
  'devtmpfs',
  'devpts',
  'cgroup',
  'cgroup2',
  'overlay',
  'squashfs',
  'autofs',
  'debugfs',
  'tracefs',
  'securityfs',
  'pstore',
  'bpf',
  'nsfs',
  'fusectl',
  'mqueue',
  'hugetlbfs',
  'configfs',
  'rpc_pipefs',
  'binfmt_misc',
  'efivarfs',
  'tmpfs'
])

async function listLinux(): Promise<DriveInfo[]> {
  try {
    const text = await fs.readFile('/proc/mounts', 'utf8')
    const drives: DriveInfo[] = []
    const seen = new Set<string>()
    const mounts: Array<{ mount: string; fsType: string }> = []
    for (const line of text.split('\n')) {
      const parts = line.split(' ')
      if (parts.length < 3) continue
      const mount = parts[1]?.replace(/\\([0-7]{3})/g, (_match, octal: string) =>
        String.fromCharCode(parseInt(octal, 8))
      )
      const fsType = parts[2]
      if (!mount || !fsType || PSEUDO_FS.has(fsType)) continue
      if (seen.has(mount)) continue
      seen.add(mount)
      mounts.push({ mount, fsType })
    }
    await forEachConcurrent(mounts, 8, async ({ mount, fsType }) => {
      const info = await fromStatfs(mount, {
        label: mount,
        fsType,
        kind: fsType.includes('nfs') || fsType.includes('cifs') || fsType.includes('smb') ? 'network' : 'fixed'
      })
      if (info) drives.push(info)
    })
    return drives.sort((a, b) => a.path.localeCompare(b.path))
  } catch {
    const info = await fromStatfs('/', { label: os.hostname(), kind: 'fixed' })
    return info ? [info] : []
  }
}

async function discoverDrives(): Promise<DriveInfo[]> {
  if (process.platform === 'win32') return listWindows()
  if (process.platform === 'darwin') return listMac()
  return listLinux()
}

let discovery: Promise<DriveInfo[]> | null = null

export function listDrives(): Promise<DriveInfo[]> {
  discovery ??= discoverDrives().finally(() => {
    discovery = null
  })
  return discovery
}

export async function spaceAt(target: string): Promise<{ total: number; free: number; volumeRoot: boolean }> {
  const volumeRoot = await isVolumeRoot(target)
  try {
    const s = await fs.statfs(target)
    const bsize = Number(s.bsize)
    return { total: Number(s.blocks) * bsize, free: Number(s.bavail) * bsize, volumeRoot }
  } catch {
    return { total: 0, free: 0, volumeRoot }
  }
}
