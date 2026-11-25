import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { linuxIcon, type IconSource } from './app-icons'
import type { AppEntry } from './apps'
import { discoverGames, heroicFiles, mergeGames, type GameLibraries } from './apps-games'
import { discoverHomebrew, homebrewPrefixes } from './apps-homebrew'
import { forEachConcurrent } from './concurrency'
import { fs } from './real-fs'
import { decodeXml } from './xml'

const execFileAsync = promisify(execFile)

const MAX_DESKTOP_FILE_BYTES = 256 * 1024
const MAX_METADATA_BYTES = 4 * 1024 * 1024

// Flatpak IDs are reverse-DNS names and snap names are lowercase words. Desktop entries in the
// user's own folders can say anything, so these are checked before they become paths.
const FLATPAK_ID = /^[A-Za-z_][\w-]*(\.[A-Za-z_][\w-]*)+$/
const SNAP_NAME = /^[a-z0-9][a-z0-9-]*(_[a-z0-9]+)?$/

/** A menu entry: a desktop file that launches an application. */
export interface Launcher {
  /** Desktop file ID, such as `org.gnome.Calculator.desktop`. */
  id: string
  file: string
  name: string
  exec: string
  /** The Icon key: an icon name or an image path. */
  icon: string
  flatpak: string
  snap: string
}

function unescapeValue(value: string): string {
  return value.replace(/\\([sntr\\])/g, (_match, c: string) =>
    c === 's' ? ' ' : c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : '\\'
  )
}

/** Keys of the [Desktop Entry] group of a desktop file, without the localized variants. */
export function parseDesktopEntry(text: string): Map<string, string> {
  const keys = new Map<string, string>()
  let inEntry = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('[')) {
      inEntry = line === '[Desktop Entry]'
      continue
    }
    const eq = line.indexOf('=')
    if (!inEntry || eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (!key.includes('[') && !keys.has(key)) keys.set(key, unescapeValue(line.slice(eq + 1).trim()))
  }
  return keys
}

/** The program an Exec line runs, past an `env VAR=value` prefix. */
export function execProgram(exec: string): string {
  const args: string[] = []
  let current = ''
  let quoted = false
  let started = false
  for (let i = 0; i < exec.length; i++) {
    const c = exec[i]
    if (quoted && c === '\\' && i + 1 < exec.length) {
      current += exec[++i]
    } else if (c === '"') {
      quoted = !quoted
      started = true
    } else if (!quoted && /\s/.test(c)) {
      if (started) args.push(current)
      current = ''
      started = false
    } else {
      current += c
      started = true
    }
  }
  if (started) args.push(current)
  let i = 0
  if (args[0] === 'env' || args[0] === '/usr/bin/env') {
    i = 1
    while (i < args.length && (args[i].includes('=') || args[i].startsWith('-'))) i++
  }
  return args[i] ?? ''
}

/** A desktop entry that should appear in the applications menu, or null. */
export function launcherOf(id: string, file: string, keys: Map<string, string>): Launcher | null {
  if (keys.get('Type') !== 'Application' || keys.get('NoDisplay') === 'true' || keys.get('Hidden') === 'true') {
    return null
  }
  const name = keys.get('Name') ?? ''
  if (!name) return null
  const fromSnapd = file.startsWith('/var/lib/snapd/desktop/')
  return {
    id,
    file,
    name,
    exec: keys.get('Exec') ?? '',
    icon: keys.get('Icon') ?? '',
    flatpak: keys.get('X-Flatpak') ?? '',
    // snapd names its desktop files <snap>_<app>.desktop.
    snap: keys.get('X-SnapInstanceName') ?? (fromSnapd ? id.slice(0, Math.max(0, id.indexOf('_'))) : '')
  }
}

function dataDirs(home: string, env: NodeJS.ProcessEnv): string[] {
  const dataHome = env.XDG_DATA_HOME?.startsWith('/') ? env.XDG_DATA_HOME : path.join(home, '.local', 'share')
  const system = (env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter((d) => d.startsWith('/'))
  // Sessions usually list the Flatpak and snap exports already; an app started another way may not.
  const exports = [path.join(dataHome, 'flatpak', 'exports', 'share'), '/var/lib/flatpak/exports/share']
  return [...new Set([dataHome, ...system, ...exports, '/var/lib/snapd/desktop'].map((d) => path.normalize(d)))]
}

async function readSmall(file: string, limit: number): Promise<string | null> {
  try {
    const stats = await fs.stat(file)
    if (!stats.isFile() || stats.size > limit) return null
    return await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
}

/** Menu entries in XDG precedence: an ID found in an earlier folder hides the same ID further on. */
async function findLaunchers(home: string, env: NodeJS.ProcessEnv): Promise<Launcher[]> {
  const files = new Map<string, string>()
  const collect = async (folder: string, prefix: string, depth: number) => {
    let entries
    try {
      entries = await fs.readdir(folder, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(folder, entry.name)
      if (entry.isDirectory() && depth === 0) await collect(file, `${prefix}${entry.name}-`, 1)
      else if (entry.name.endsWith('.desktop') && (entry.isFile() || entry.isSymbolicLink())) {
        const id = prefix + entry.name
        if (!files.has(id)) files.set(id, file)
      }
    }
  }
  for (const dir of dataDirs(home, env)) await collect(path.join(dir, 'applications'), '', 0)

  const launchers: Launcher[] = []
  await forEachConcurrent(files, 16, async ([id, file]) => {
    const text = await readSmall(file, MAX_DESKTOP_FILE_BYTES)
    const launcher = text === null ? null : launcherOf(id, file, parseDesktopEntry(text))
    if (launcher) launchers.push(launcher)
  })
  return launchers.sort((a, b) => a.id.localeCompare(b.id))
}

export interface PackageInfo {
  name: string
  version: string
  /** Size the package database records, in bytes. */
  size: number
  installedAt: number
}

/** Installed packages in /var/lib/dpkg/status, by name. */
export function parseDpkgStatus(text: string): Map<string, PackageInfo> {
  const packages = new Map<string, PackageInfo>()
  for (const stanza of text.split(/\n\s*\n/)) {
    const field = (name: string) => new RegExp(`^${name}:[ \\t]*(.*)$`, 'm').exec(stanza)?.[1]?.trim() ?? ''
    const name = field('Package')
    if (!name || !/\binstalled$/.test(field('Status'))) continue
    const kib = Number(field('Installed-Size'))
    packages.set(name, {
      name,
      version: field('Version'),
      size: Number.isFinite(kib) && kib > 0 ? kib * 1024 : 0,
      installedAt: 0
    })
  }
  return packages
}

/** A pacman local database `desc` file. */
export function parsePacmanDesc(text: string): PackageInfo | null {
  const field = (name: string) => new RegExp(`^%${name}%\\n([^\\n]*)`, 'm').exec(text)?.[1]?.trim() ?? ''
  const name = field('NAME')
  if (!name) return null
  const size = Number(field('SIZE'))
  const installed = Number(field('INSTALLDATE'))
  return {
    name,
    version: field('VERSION'),
    size: Number.isFinite(size) && size > 0 ? size : 0,
    installedAt: Number.isFinite(installed) && installed > 0 ? installed * 1000 : 0
  }
}

/** Files a pacman `files` entry lists, as absolute paths. */
export function parsePacmanFiles(text: string): string[] {
  const start = text.indexOf('%FILES%\n')
  if (start === -1) return []
  const files: string[] = []
  for (const line of text.slice(start + 8).split('\n')) {
    if (!line || line.startsWith('%')) break
    files.push(`/${line}`)
  }
  return files
}

/** A package that owns menu entries, with the files it installed. */
interface OwnedPackage extends PackageInfo {
  source: 'deb' | 'rpm' | 'pacman'
  files: string[]
  launchers: Launcher[]
}

type Owners = Map<string, OwnedPackage>

function own(owners: Owners, launcher: Launcher, pkg: Omit<OwnedPackage, 'launchers'>): void {
  const key = `${pkg.source}:${pkg.name}`
  const owner = owners.get(key) ?? { ...pkg, launchers: [] }
  owner.launchers.push(launcher)
  owners.set(key, owner)
}

async function dpkgOwners(launchers: Map<string, Launcher>, owners: Owners): Promise<void> {
  const status = await readSmall('/var/lib/dpkg/status', 64 * MAX_METADATA_BYTES)
  if (status === null) return
  const packages = parseDpkgStatus(status)
  const info = '/var/lib/dpkg/info'
  let lists: string[]
  try {
    lists = (await fs.readdir(info)).filter((name) => name.endsWith('.list'))
  } catch {
    return
  }
  await forEachConcurrent(lists, 16, async (list) => {
    if (!launchers.size) return
    const file = path.join(info, list)
    const text = await readSmall(file, MAX_METADATA_BYTES)
    if (text === null || !text.includes('/applications/')) return
    const files = text.split('\n').filter(Boolean)
    const owned = files.flatMap((f) => {
      const launcher = launchers.get(f)
      return launcher ? [launcher] : []
    })
    if (!owned.length) return
    // Packages built for several architectures keep their list as <name>:<arch>.list.
    const name = list.slice(0, -'.list'.length).replace(/:[^:]+$/, '')
    const pkg = packages.get(name)
    if (!pkg) return
    const installedAt = await fs.stat(file).then(
      (s) => s.mtimeMs,
      () => 0
    )
    for (const launcher of owned) {
      launchers.delete(launcher.file)
      own(owners, launcher, { ...pkg, installedAt, source: 'deb', files })
    }
  })
}

async function pacmanOwners(launchers: Map<string, Launcher>, owners: Owners): Promise<void> {
  const local = '/var/lib/pacman/local'
  let dirs: string[]
  try {
    dirs = await fs.readdir(local)
  } catch {
    return
  }
  await forEachConcurrent(dirs, 16, async (dir) => {
    if (!launchers.size) return
    const filesText = await readSmall(path.join(local, dir, 'files'), MAX_METADATA_BYTES)
    if (filesText === null || !filesText.includes('/applications/')) return
    const files = parsePacmanFiles(filesText)
    const owned = files.flatMap((f) => {
      const launcher = launchers.get(f)
      return launcher ? [launcher] : []
    })
    if (!owned.length) return
    const desc = await readSmall(path.join(local, dir, 'desc'), MAX_METADATA_BYTES)
    const pkg = desc === null ? null : parsePacmanDesc(desc)
    if (!pkg) return
    for (const launcher of owned) {
      launchers.delete(launcher.file)
      own(owners, launcher, { ...pkg, source: 'pacman', files })
    }
  })
}

async function rpmPath(): Promise<string | null> {
  for (const candidate of ['/usr/bin/rpm', '/bin/rpm']) {
    try {
      await fs.access(candidate)
      return candidate
    } catch {
      /* try the next */
    }
  }
  return null
}

async function rpmQuery(rpm: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(rpm, args, { timeout: 15000, maxBuffer: 16 * 1024 * 1024 })
    return stdout
  } catch (error) {
    // rpm exits non-zero for a file no package owns, after printing a note to stdout.
    const stdout = (error as { stdout?: unknown }).stdout
    return typeof stdout === 'string' ? stdout : ''
  }
}

async function rpmOwners(launchers: Map<string, Launcher>, owners: Owners): Promise<void> {
  if (!launchers.size) return
  const rpm = await rpmPath()
  if (!rpm) return
  const fileLists = new Map<string, Promise<string[]>>()
  await forEachConcurrent([...launchers.values()], 8, async (launcher) => {
    const line = (
      await rpmQuery(rpm, [
        '-qf',
        '--qf',
        '%{NAME}\\t%{VERSION}-%{RELEASE}\\t%{SIZE}\\t%{INSTALLTIME}\\n',
        launcher.file
      ])
    ).split('\n')[0]
    const [name, version, size, installed] = line.split('\t')
    if (!name || version === undefined || installed === undefined) return
    let files = fileLists.get(name)
    if (!files) {
      files = rpmQuery(rpm, ['-ql', name]).then((out) => out.split('\n').filter((f) => f.startsWith('/')))
      fileLists.set(name, files)
    }
    launchers.delete(launcher.file)
    own(owners, launcher, {
      name,
      version,
      size: Number(size) > 0 ? Number(size) : 0,
      installedAt: Number(installed) > 0 ? Number(installed) * 1000 : 0,
      source: 'rpm',
      files: await files
    })
  })
}

/** The launcher that names a package best: the one whose ID is the package name, else the shortest name. */
function mainLauncher(name: string, launchers: Launcher[]): Launcher {
  const base = (l: Launcher) => l.id.replace(/\.desktop$/, '').toLowerCase()
  const lower = name.toLowerCase()
  return (
    launchers.find((l) => base(l) === lower || base(l).endsWith(`.${lower}`)) ??
    [...launchers].sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name))[0]
  )
}

async function mtimeOf(file: string): Promise<number> {
  try {
    return (await fs.stat(file)).mtimeMs
  } catch {
    return 0
  }
}

async function isFolder(folder: string): Promise<boolean> {
  try {
    return (await fs.lstat(folder)).isDirectory()
  } catch {
    return false
  }
}

/** The name and newest release of a Flatpak app's AppStream metadata. */
export function appStreamInfo(xml: string): { name: string; version: string } {
  // The untranslated name is the one without xml:lang, under the component rather than a release.
  const component = xml.replace(/<releases\b[\s\S]*?<\/releases>/g, '')
  return {
    name: decodeXml(/<name>([^<]*)<\/name>/.exec(component)?.[1] ?? '').trim(),
    version: /<release\b[^>]*\bversion="([^"]+)"/.exec(xml)?.[1] ?? ''
  }
}

async function flatpakApp(id: string, launcher: Launcher | null, home: string): Promise<AppEntry | null> {
  if (!FLATPAK_ID.test(id)) return null
  const userRoot = path.join(home, '.local', 'share', 'flatpak')
  const roots = launcher?.file.startsWith(`${userRoot}/`) ? [userRoot] : ['/var/lib/flatpak', userRoot]
  for (const root of roots) {
    const folder = path.join(root, 'app', id)
    if (!(await isFolder(folder))) continue
    const active = path.join(folder, 'current', 'active')
    let version = ''
    let title = ''
    for (const name of [`${id}.metainfo.xml`, `${id}.appdata.xml`]) {
      for (const dir of ['metainfo', 'appdata']) {
        const xml = await readSmall(path.join(active, 'files', 'share', dir, name), MAX_METADATA_BYTES)
        if (!xml) continue
        const info = appStreamInfo(xml)
        version ||= info.version
        title ||= info.name
      }
    }
    // Runtimes are shared by many apps, so only the app's own deployment is counted.
    return {
      name: launcher?.name || title || id.slice(id.lastIndexOf('.') + 1),
      version,
      publisher: '',
      source: 'flatpak',
      footprint: { kind: 'folder', path: folder },
      estimate: null,
      installedAt: await mtimeOf(active)
    }
  }
  return null
}

const SNAPS = '/var/lib/snapd/snaps'

/** The snap files kept for each snap: the current revision and the older ones snapd retains. */
async function snapFiles(): Promise<Map<string, string[]>> {
  const snaps = new Map<string, string[]>()
  let names: string[]
  try {
    names = await fs.readdir(SNAPS)
  } catch {
    return snaps
  }
  for (const name of names) {
    const match = /^(.+)_x?\d+\.snap$/.exec(name)
    if (!match) continue
    snaps.set(match[1], [...(snaps.get(match[1]) ?? []), path.join(SNAPS, name)])
  }
  return snaps
}

/**
 * Whether a snap.yaml describes an app someone installed: not a base, kernel or snapd itself, and with
 * commands to run. Content snaps, such as GNOME's platform for other snaps, have none.
 */
export function isAppSnap(yaml: string): boolean {
  const type = /^type:[ \t]*['"]?([\w-]+)/m.exec(yaml)?.[1] ?? 'app'
  return type === 'app' && /^apps:[ \t]*$/m.test(yaml)
}

/**
 * A snap, named after its menu entry, else its title, else itself. Snaps without a menu entry are
 * listed only when they are apps.
 */
async function snapApp(name: string, title: string | null, snaps: Map<string, string[]>): Promise<AppEntry | null> {
  const files = SNAP_NAME.test(name) ? snaps.get(name) : undefined
  if (!files?.length) return null
  const yaml = await readSmall(`/snap/${name}/current/meta/snap.yaml`, MAX_METADATA_BYTES)
  if (title === null && (yaml === null || !isAppSnap(yaml))) return null
  const times = await Promise.all(files.map(mtimeOf))
  const newest = times.indexOf(Math.max(...times))
  const yamlTitle = (yaml && /^title:[ \t]*['"]?([^'"\n]*?)['"]?[ \t]*$/m.exec(yaml)?.[1]) || ''
  return {
    name: title ?? (yamlTitle || name),
    version: (yaml && /^version:[ \t]*['"]?([^'"\n]*?)['"]?[ \t]*$/m.exec(yaml)?.[1]) || '',
    publisher: '',
    source: 'snap',
    location: files[newest],
    // Snaps stay compressed on disk and are mounted to run, so the snap files are their real size.
    footprint: { kind: 'files', paths: files },
    estimate: null,
    installedAt: times[newest]
  }
}

/** Name and version from an AppImage file name such as `Editor-1.2.3-x86_64.AppImage`. */
export function appImageName(file: string): { name: string; version: string } {
  const base = path.basename(file).replace(/\.appimage$/i, '')
  const match = /^(.+?)[-_ ]v?(\d[\w.]*?)(?:[-_.](?:x86_64|amd64|x64|aarch64|arm64|armhf|i386|i686))?$/i.exec(base)
  return match ? { name: match[1], version: match[2] } : { name: base, version: '' }
}

async function appImageApp(file: string, name: string | null): Promise<AppEntry | null> {
  try {
    const stats = await fs.lstat(file)
    if (!stats.isFile()) return null
    const parsed = appImageName(file)
    return {
      name: name || parsed.name,
      version: parsed.version,
      publisher: '',
      source: 'appimage',
      location: file,
      footprint: { kind: 'files', paths: [file] },
      estimate: null,
      installedAt: stats.mtimeMs
    }
  } catch {
    return null
  }
}

/** Where AppImages are commonly kept; integration tools such as AppImageLauncher use ~/Applications. */
async function looseAppImages(home: string): Promise<string[]> {
  const found: string[] = []
  for (const folder of [
    'Applications',
    'AppImages',
    'Apps',
    'bin',
    path.join('.local', 'bin'),
    'Downloads',
    'Desktop'
  ]) {
    try {
      for (const entry of await fs.readdir(path.join(home, folder), { withFileTypes: true })) {
        if (entry.isFile() && /\.appimage$/i.test(entry.name)) found.push(path.join(home, folder, entry.name))
      }
    } catch {
      /* not there */
    }
  }
  return found
}

/** A program in a folder of its own under /opt that no package installed: /opt/<folder>. */
export function optFolder(program: string): string | null {
  const match = /^\/opt\/([^/]+)\/./.exec(path.posix.normalize(program))
  return match && match[1] !== '..' && match[1] !== '.' ? `/opt/${match[1]}` : null
}

// Folders a program sits in below its own folder.
const INNER_FOLDER = /^(bin|sbin|libexec|x86_64|x64|amd64|aarch64|arm64)$/
// Folders of /usr/local that hold the files of many programs.
const USR_LOCAL_SHARED = new Set([
  'bin',
  'sbin',
  'lib',
  'lib64',
  'libexec',
  'share',
  'include',
  'etc',
  'man',
  'src',
  'games'
])
// Folders of the home folder that hold the files of many programs, or the user's own.
const HOME_SHARED = [
  '',
  '.local',
  '.local/share',
  '.local/bin',
  '.local/lib',
  '.local/share/applications',
  'bin',
  'Applications',
  'AppImages',
  'Apps',
  'Desktop',
  'Documents',
  'Downloads',
  'Games'
]
// Folders of the home folder whose contents other parts of the list already count, or that are caches.
const HOME_EXCLUDED = ['.var', 'snap', '.cache', '.steam', '.local/share/Steam', '.local/share/flatpak', '.wine']

/**
 * The folder of a program no package installed: /opt/<folder>, /usr/local/<folder>, or the folder it
 * is in below the home folder, past a bin or similar subfolder, as with tarballs and JetBrains Toolbox.
 */
export function ownFolder(program: string, home: string): string | null {
  if (!program.startsWith('/')) return null
  const normalized = path.posix.normalize(program)
  const opt = optFolder(normalized)
  if (opt) return opt
  const local = /^\/usr\/local\/([^/]+)\/./.exec(normalized)
  if (local) return USR_LOCAL_SHARED.has(local[1]) || local[1] === '..' ? null : `/usr/local/${local[1]}`
  const base = path.posix.normalize(home).replace(/\/+$/, '')
  if (!normalized.startsWith(`${base}/`)) return null
  let folder = path.posix.dirname(normalized)
  while (INNER_FOLDER.test(path.posix.basename(folder)) && folder.startsWith(`${base}/`)) {
    folder = path.posix.dirname(folder)
  }
  const inside = path.posix.relative(base, folder)
  if (inside.startsWith('..') || HOME_SHARED.includes(inside)) return null
  if (HOME_EXCLUDED.some((excluded) => inside === excluded || inside.startsWith(`${excluded}/`))) return null
  return folder
}

/** The Flatpak apps installed system-wide and for the user, by ID, menu entry or not. */
async function flatpakIds(home: string): Promise<string[]> {
  const ids = new Set<string>()
  for (const root of ['/var/lib/flatpak', path.join(home, '.local', 'share', 'flatpak')]) {
    try {
      for (const id of await fs.readdir(path.join(root, 'app'))) if (FLATPAK_ID.test(id)) ids.add(id)
    } catch {
      /* not installed */
    }
  }
  return [...ids]
}

/**
 * Applications in the menu, each with the files it installed. Packages are found through the
 * desktop files they own; their sizes leave out shared libraries and other packages they need.
 */
export async function discoverLinuxApps(home: string, env: NodeJS.ProcessEnv = process.env): Promise<AppEntry[]> {
  const launchers = await findLaunchers(home, env)
  // Icons are looked up only when shown, in the data folders the menu entries came from.
  const dirs = dataDirs(home, env)
  const iconOf = (launcher: Launcher) => (launcher.icon ? linuxIcon(launcher.icon, dirs) : null)
  const withIcon = (app: AppEntry | null, launcher: Launcher) => app && { ...app, icon: iconOf(launcher) }
  const apps: AppEntry[] = []
  const unowned = new Map<string, Launcher>()
  const flatpaks = new Map<string, Launcher>()
  const snapLaunchers = new Map<string, Launcher>()
  const appImages = new Map<string, Launcher>()
  for (const launcher of launchers) {
    const program = execProgram(launcher.exec)
    if (launcher.flatpak) {
      if (!flatpaks.has(launcher.flatpak)) flatpaks.set(launcher.flatpak, launcher)
    } else if (launcher.snap) {
      if (!snapLaunchers.has(launcher.snap)) snapLaunchers.set(launcher.snap, launcher)
    } else if (program.startsWith('/') && /\.appimage$/i.test(program)) {
      if (!appImages.has(program)) appImages.set(program, launcher)
    } else {
      unowned.set(launcher.file, launcher)
    }
  }

  const snaps = await snapFiles()
  const listed = await Promise.all([
    ...[...flatpaks].map(([id, launcher]) => flatpakApp(id, launcher, home).then((app) => withIcon(app, launcher))),
    ...[...snapLaunchers].map(([name, launcher]) =>
      snapApp(name, launcher.name, snaps).then((app) => withIcon(app, launcher))
    ),
    ...[...appImages].map(([file, launcher]) => appImageApp(file, launcher.name).then((app) => withIcon(app, launcher)))
  ])
  for (const app of listed) if (app) apps.push(app)
  // Apps installed without a menu entry, such as command-line tools and services, take space too.
  const unlisted = await Promise.all([
    ...(await flatpakIds(home)).filter((id) => !flatpaks.has(id)).map((id) => flatpakApp(id, null, home)),
    ...[...snaps.keys()].filter((name) => !snapLaunchers.has(name)).map((name) => snapApp(name, null, snaps))
  ])
  for (const app of unlisted) if (app) apps.push(app)
  for (const file of await looseAppImages(home)) {
    if (appImages.has(file)) continue
    const app = await appImageApp(file, null)
    if (app) apps.push(app)
  }

  // Each package database claims the desktop files it installed; the rest may be programs in /opt.
  const owners: Owners = new Map()
  await dpkgOwners(unowned, owners)
  await pacmanOwners(unowned, owners)
  await rpmOwners(unowned, owners)
  for (const pkg of owners.values()) {
    const main = mainLauncher(pkg.name, pkg.launchers)
    apps.push({
      name: main.name,
      version: pkg.version,
      publisher: '',
      source: pkg.source,
      location: null,
      footprint: { kind: 'files', paths: pkg.files },
      estimate: pkg.size || null,
      installedAt: pkg.installedAt,
      icon: iconOf(main)
    })
  }
  const optApps = new Map<string, Launcher>()
  for (const launcher of unowned.values()) {
    const folder = ownFolder(execProgram(launcher.exec), home)
    if (folder && !optApps.has(folder)) optApps.set(folder, launcher)
  }
  for (const [folder, launcher] of optApps) {
    if (!(await isFolder(folder))) continue
    apps.push({
      name: launcher.name,
      version: '',
      publisher: '',
      source: 'folder',
      footprint: { kind: 'folder', path: folder },
      estimate: null,
      installedAt: await mtimeOf(folder),
      icon: iconOf(launcher)
    })
  }

  // Steam's menu shortcuts start a game by its app ID; no package owns them, but they name its icon.
  const steamIcons = new Map<string, IconSource>()
  for (const launcher of launchers) {
    const id = /\bsteam:\/\/rungameid\/(\d+)\b/.exec(launcher.exec)?.[1]
    const icon = id && !steamIcons.has(id) ? iconOf(launcher) : null
    if (id && icon) steamIcons.set(id, icon)
  }
  const games = await discoverGames(linuxGameLibraries(home, env), { path: path.posix, steamIcons })
  const brew = await discoverHomebrew(homebrewPrefixes('linux', home, env))
  return [...mergeGames(apps, games, false), ...brew]
}

/** Where Steam (native, Flatpak or snap) and Legendary or Heroic keep their records of installed games. */
export function linuxGameLibraries(home: string, env: NodeJS.ProcessEnv = process.env): GameLibraries {
  const dataHome = env.XDG_DATA_HOME?.startsWith('/') ? env.XDG_DATA_HOME : path.posix.join(home, '.local', 'share')
  const configHome = env.XDG_CONFIG_HOME?.startsWith('/') ? env.XDG_CONFIG_HOME : path.posix.join(home, '.config')
  const flatpakHeroic = path.posix.join(home, '.var', 'app', 'com.heroicgameslauncher.hgl', 'config')
  return {
    // ~/.steam/steam is usually a link to one of the others; libraries are told apart by their real path.
    steamRoots: [
      path.posix.join(dataHome, 'Steam'),
      path.posix.join(home, '.steam', 'steam'),
      path.posix.join(home, '.steam', 'root'),
      path.posix.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam'),
      path.posix.join(home, '.var', 'app', 'com.valvesoftware.Steam', 'data', 'Steam'),
      path.posix.join(home, 'snap', 'steam', 'common', '.local', 'share', 'Steam')
    ],
    epicManifests: [],
    ...heroicFiles([configHome, flatpakHeroic], path.posix)
  }
}
