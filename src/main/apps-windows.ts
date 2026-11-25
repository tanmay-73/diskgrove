import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { isWithin } from '@shared/paths'
import { packagePath, type IconSource } from './app-icons'
import type { AppEntry } from './apps'
import { discoverGames, gameLibraryFolders, heroicFiles, mergeGames, type GameLibraries } from './apps-games'
import { forEachConcurrent } from './concurrency'
import { nativePath } from './disk-usage'
import { powershellPath } from './drives'
import { fs } from './real-fs'
import { decodeXml } from './xml'

const execFileAsync = promisify(execFile)

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024

// Settings > Apps reads the same uninstall keys: 64-bit and 32-bit programs for all users, then the
// current user's. Store apps come from Get-AppxPackage, named as the Start menu names them.
// Each source is optional, so one failing leaves the others. Windows Installer packages that set no
// DisplayIcon keep their icon in the installer's cache, which Windows Installer reports by product code.
const WINDOWS_APPS_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
  '$installer = $null',
  'try { $installer = New-Object -ComObject WindowsInstaller.Installer } catch { }',
  "$productIcon = @{ Name = 'ProductIcon'; Expression = { if ($installer -and $_.WindowsInstaller -eq 1 -and -not $_.DisplayIcon) { try { $installer.ProductInfo($_.PSChildName, 'ProductIcon') } catch { } } } }",
  "$fields = 'DisplayName', 'DisplayVersion', 'Publisher', 'InstallLocation', 'InstallDate', 'EstimatedSize', 'DisplayIcon', 'UninstallString', 'SystemComponent', 'ParentKeyName', 'ReleaseType', $productIcon",
  "$keys = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKCU:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'",
  '$registry = @()',
  'try { $registry = @(foreach ($key in $keys) { Get-ItemProperty -Path $key | Where-Object { $_.DisplayName } | Select-Object -Property $fields }) } catch { }',
  '$names = @{}',
  "try { foreach ($app in @(Get-StartApps)) { $family = ($app.AppID -split '!')[0]; if ($app.AppID -like '*!*' -and -not $names.ContainsKey($family)) { $names[$family] = $app.Name } } } catch { }",
  '$store = @()',
  "try { $store = @(Get-AppxPackage | Where-Object { -not $_.IsFramework -and -not $_.IsResourcePackage -and [string]$_.SignatureKind -ne 'System' -and $_.InstallLocation } | ForEach-Object { @{ Name = $_.Name; StartName = $names[$_.PackageFamilyName]; Version = [string]$_.Version; Publisher = $_.Publisher; InstallLocation = $_.InstallLocation } }) } catch { }",
  // Game launchers record their games in their own files, found from where each launcher is installed.
  "$steam = @(foreach ($key in 'HKCU:\\SOFTWARE\\Valve\\Steam', 'HKLM:\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'HKLM:\\SOFTWARE\\Valve\\Steam') { $p = Get-ItemProperty -Path $key; if ($p.SteamPath) { [string]$p.SteamPath }; if ($p.InstallPath) { [string]$p.InstallPath } })",
  "$epic = @(foreach ($key in 'HKLM:\\SOFTWARE\\WOW6432Node\\Epic Games\\EpicGamesLauncher', 'HKLM:\\SOFTWARE\\Epic Games\\EpicGamesLauncher') { $p = Get-ItemProperty -Path $key; if ($p.AppDataPath) { [string]$p.AppDataPath } })",
  "$gog = @(Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\WOW6432Node\\GOG.com\\Games\\*' | Where-Object { $_.path } | ForEach-Object { @{ Name = [string]$_.gameName; Folder = [string]$_.path; Version = [string]$_.ver; Exe = [string]$_.exe } })",
  // Programs no installer registered, such as portable ones, are known by their Start menu and desktop shortcuts.
  '$shortcuts = @()',
  "try { $shell = New-Object -ComObject WScript.Shell; $shortcuts = @(foreach ($dir in [Environment]::GetFolderPath('CommonPrograms'), [Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('CommonDesktopDirectory'), [Environment]::GetFolderPath('DesktopDirectory')) { if ($dir) { Get-ChildItem -LiteralPath $dir -Recurse -Filter *.lnk -File | ForEach-Object { try { $target = $shell.CreateShortcut($_.FullName).TargetPath; if ($target -like '*.exe') { $info = (Get-Item -LiteralPath $target).VersionInfo; @{ Name = $_.BaseName; Target = $target; Version = [string]$info.ProductVersion; Publisher = [string]$info.CompanyName } } } catch { } } } }) } catch { }",
  // Components that ship with Windows carry the version of its own files, which can trail the build it reports.
  "$system = ''; try { $system = [string](Get-Item -LiteralPath (Join-Path $env:SystemRoot 'System32\\kernel32.dll')).VersionInfo.ProductVersion } catch { }",
  '@{ Registry = $registry; Store = $store; Steam = $steam; Epic = $epic; Gog = $gog; Shortcuts = $shortcuts; SystemVersion = $system } | ConvertTo-Json -Depth 3 -Compress'
].join('\n')

interface RegistryRow {
  DisplayName?: unknown
  DisplayVersion?: unknown
  Publisher?: unknown
  InstallLocation?: unknown
  InstallDate?: unknown
  EstimatedSize?: unknown
  DisplayIcon?: unknown
  UninstallString?: unknown
  SystemComponent?: unknown
  ParentKeyName?: unknown
  ReleaseType?: unknown
  /** The icon Windows Installer cached for a package without a DisplayIcon. */
  ProductIcon?: unknown
}

interface StoreRow {
  Name?: unknown
  StartName?: unknown
  /** Added from the package manifest. */
  ManifestName?: unknown
  /** A sparse package: an identity for a desktop program listed on its own, with no files of its own. */
  External?: unknown
  /** Added from the package manifest: the logo the Start menu shows, relative to the package folder. */
  Logo?: unknown
  Version?: unknown
  Publisher?: unknown
  InstallLocation?: unknown
}

export interface WindowsAppData {
  Registry?: unknown
  Store?: unknown
  /** Folders Steam's registry keys name as its install. */
  Steam?: unknown
  /** Epic Games Launcher data folders, which hold its Manifests folder. */
  Epic?: unknown
  /** Games GOG Galaxy and GOG's installers registered. */
  Gog?: unknown
  /** Start menu and desktop shortcuts to executables, with the version and company those report. */
  Shortcuts?: unknown
  /** The version of Windows' own files, such as `10.0.26100.9549`. */
  SystemVersion?: unknown
}

export interface WindowsFolders {
  /** %SystemRoot%. Drivers and system components register folders there that are not theirs alone. */
  windows: string
  /** Folders programs install into, so an uninstaller or icon below one is in the program's folder. */
  programRoots: string[]
  /** Folders shared by many programs: an app's folder may be inside one but never be one. */
  shared: string[]
  /** %USERPROFILE%. Outside its program folders, what is in it is the user's own files. */
  profile: string | null
}

export function windowsFolders(env: NodeJS.ProcessEnv = process.env): WindowsFolders {
  const defined = (...values: Array<string | undefined>) => values.filter((v): v is string => Boolean(v))
  const local = env.LOCALAPPDATA
  const roaming = env.APPDATA
  const programFiles = defined(env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)'])
  const programRoots = defined(...programFiles, local && path.win32.join(local, 'Programs'), local, roaming)
  return {
    windows: env.SystemRoot || env.windir || 'C:\\Windows',
    programRoots,
    shared: defined(
      ...programRoots,
      ...programFiles.map((p) => path.win32.join(p, 'WindowsApps')),
      // The Epic Games Launcher registers its default games library as its own folder.
      ...programFiles.map((p) => path.win32.join(p, 'Epic Games')),
      env.CommonProgramW6432,
      env.CommonProgramFiles,
      env['CommonProgramFiles(x86)'],
      env.ProgramData,
      env.PUBLIC,
      env.USERPROFILE,
      env.USERPROFILE && path.win32.dirname(env.USERPROFILE),
      local && path.win32.join(local, 'Microsoft'),
      roaming && path.win32.join(roaming, 'Microsoft')
    ),
    profile: env.USERPROFILE || null
  }
}

// Folders an executable sits in below its program's own folder.
const INNER_FOLDER = /^(bin|bin32|bin64|32bit|64bit|x64|x86|amd64|arm64|win32|win64|program|current|cef|app-[\d.]+)$/i
// Folders that hold installers, caches or shared components rather than a program.
const NOT_PROGRAM_FOLDER = new Set([
  'common files',
  'installer',
  'installer2',
  'installshield installation information',
  'package cache',
  'packages',
  'temp',
  'uninstall information',
  'windowsapps'
])

/** Whether a folder is in, or is, a folder that holds installers or caches. */
function inInstallerFolder(folder: string): boolean {
  return folder.split('\\').some((segment) => NOT_PROGRAM_FOLDER.has(segment.toLowerCase()))
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

function within(root: string, target: string): boolean {
  return isWithin(root.toLowerCase().replace(/\\+$/, ''), target.toLowerCase())
}

/** A local absolute folder path from a registry value, which may be quoted or end in a backslash. */
export function cleanFolder(raw: unknown): string | null {
  const value = text(raw)
    .replace(/^"+|"+$/g, '')
    .trim()
  if (!/^[A-Za-z]:[\\/]/.test(value) || value.includes('\0')) return null
  const normalized = path.win32.normalize(value)
  return path.win32.parse(normalized).root === normalized ? normalized : normalized.replace(/\\+$/, '')
}

/** Whether `folder` can be one app's own folder: not a drive, not shared and not part of Windows. */
export function isAppFolder(folder: string, folders: WindowsFolders): boolean {
  if (path.win32.parse(folder).root.toLowerCase() === folder.toLowerCase().replace(/\\?$/, '\\')) return false
  if (within(folders.windows, folder)) return false
  return !folders.shared.some((shared) => same(shared.replace(/\\+$/, ''), folder))
}

/** The executable at the start of a DisplayIcon (`app.exe,0`) or UninstallString (`"unins.exe" /S`). */
function executableOf(raw: unknown): string | null {
  const match = /^"?([A-Za-z]:[\\/][^"]*?\.exe)(?=$|[",\s])/i.exec(text(raw))
  return match ? cleanFolder(match[1]) : null
}

/**
 * The folder of a program that registered none, from its icon or uninstaller when that executable
 * is below a program root. Executables in bin and similar subfolders lead to the folder above.
 */
export function inferFolder(row: RegistryRow, folders: WindowsFolders): string | null {
  for (const exe of [executableOf(row.DisplayIcon), executableOf(row.UninstallString)]) {
    const folder = exe && programFolder(exe, folders, false)
    if (folder) return folder
  }
  return null
}

/**
 * The folder of the program an executable belongs to. Below a program root that is the folder the
 * executable is in, past bin and similar subfolders. With `anywhere`, a folder outside the roots also
 * counts, such as a portable program in D:\Tools\Editor, when it is at least two levels below the
 * drive and not among the user's own files.
 */
function programFolder(exe: string, folders: WindowsFolders, anywhere: boolean): string | null {
  let folder = path.win32.dirname(exe)
  while (INNER_FOLDER.test(path.win32.basename(folder))) folder = path.win32.dirname(folder)
  const root = folders.programRoots.find((r) => within(r, folder) && !same(r.replace(/\\+$/, ''), folder))
  if (root) {
    const inside = path.win32.relative(root, folder).split('\\')
    if (inside.some((segment) => NOT_PROGRAM_FOLDER.has(segment.toLowerCase()))) return null
  } else {
    if (!anywhere || (folders.profile && within(folders.profile, folder))) return null
    const parsed = path.win32.parse(folder)
    if (path.win32.relative(parsed.root, folder).split('\\').length < 2) return null
    if (folder.split('\\').some((segment) => NOT_PROGRAM_FOLDER.has(segment.toLowerCase()))) return null
  }
  return isAppFolder(folder, folders) ? folder : null
}

interface ShortcutRow {
  Name?: unknown
  Target?: unknown
  Version?: unknown
  Publisher?: unknown
}

// Shortcuts that come with a program but do not start it.
const NOT_PROGRAM_SHORTCUT =
  /\b(uninstall|uninstaller|remove|readme|read me|help|manual|documentation|website|license)\b/i
const NOT_PROGRAM_EXE = /^(unins|uninst|uninstall|setup|install)/i

/**
 * Programs known only by their shortcuts, one per folder, for folders no listed app is in or contains.
 * Each is named after the shortest of its shortcuts' names.
 */
export function shortcutApps(
  raw: unknown,
  folders: WindowsFolders,
  listed: AppEntry[],
  windowsBuild: string | null = null
): AppEntry[] {
  const taken = listed.flatMap((app) => (app.footprint?.kind === 'folder' ? [app.footprint.path] : []))
  const byFolder = new Map<string, { folder: string; exe: string; row: ShortcutRow; name: string }>()
  for (const row of rows<ShortcutRow>(raw)) {
    const name = text(row.Name)
      .replace(/\s+-\s+shortcut$/i, '')
      .trim()
    const exe = cleanFolder(row.Target)
    if (!name || !exe || !/\.exe$/i.test(exe) || NOT_PROGRAM_SHORTCUT.test(name)) continue
    if (NOT_PROGRAM_EXE.test(path.win32.basename(exe)) || isWindowsComponent(row, windowsBuild)) continue
    const folder = programFolder(exe, folders, true)
    if (!folder || taken.some((other) => within(other, folder) || within(folder, other))) continue
    const key = folder.toLowerCase()
    const known = byFolder.get(key)
    if (!known || name.length < known.name.length) byFolder.set(key, { folder, exe, row, name })
  }
  const apps = [...listed]
  for (const { folder, exe, row, name } of byFolder.values()) {
    const version = text(row.Version)
    // A program its installer registered without a folder, as Windows Installer packages often are.
    const at = apps.findIndex((app) => app.source === 'desktop' && !app.footprint && sameProgram(app, name, version))
    if (at !== -1) {
      apps[at] = {
        ...apps[at],
        footprint: { kind: 'folder', path: folder },
        icon: apps[at].icon ?? { kind: 'file', path: exe }
      }
      continue
    }
    apps.push({
      name,
      version,
      publisher: text(row.Publisher),
      source: 'folder',
      footprint: { kind: 'folder', path: folder },
      estimate: null,
      installedAt: 0,
      icon: { kind: 'file', path: exe }
    })
  }
  return apps
}

/** A name without versions, architectures and punctuation: `PowerToys (Preview) x64` is `powertoyspreview`. */
function bareName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\bv?\d+(\.\d+)+\b/g, '')
    .replace(/\b(x64|x86|arm64|64-bit|32-bit)\b/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

/** Whether a registered program is the one a shortcut starts: the same bare name, or one names the other and the versions agree. */
function sameProgram(app: AppEntry, name: string, version: string): boolean {
  const a = bareName(app.name)
  const b = bareName(name)
  if (!a || !b) return false
  if (a === b) return true
  const sameVersion = Boolean(
    app.version && version && (version.startsWith(app.version) || app.version.startsWith(version))
  )
  return sameVersion && (a.startsWith(b) || b.startsWith(a))
}

/**
 * Programs that ship with Windows, such as Windows Media Player in Program Files: Microsoft's, with a
 * version naming this Windows build (`12.0.26100.1` on build 26100).
 */
function isWindowsComponent(row: ShortcutRow, build: string | null): boolean {
  if (!build || !/^microsoft/i.test(text(row.Publisher))) return false
  return text(row.Version).split('.').includes(build)
}

interface GogRow {
  Name?: unknown
  Folder?: unknown
  Version?: unknown
  Exe?: unknown
}

/** Games GOG's registry keys list, which its installers may not register as programs. */
export function gogApps(raw: unknown, folders: WindowsFolders): AppEntry[] {
  return rows<GogRow>(raw).flatMap((row): AppEntry[] => {
    const name = text(row.Name)
    const folder = cleanFolder(row.Folder)
    if (!name || !folder || !isAppFolder(folder, folders)) return []
    const exe = cleanFolder(row.Exe)
    return [
      {
        name,
        version: text(row.Version),
        publisher: 'GOG',
        source: 'gog',
        footprint: { kind: 'folder', path: folder },
        estimate: null,
        installedAt: 0,
        icon: exe && /\.exe$/i.test(exe) ? { kind: 'file', path: exe } : null
      }
    ]
  })
}

/** The Scoop installs: the user's, then the global one. */
export function scoopRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = [
    env.SCOOP || (env.USERPROFILE && path.win32.join(env.USERPROFILE, 'scoop')),
    env.SCOOP_GLOBAL || (env.ProgramData && path.win32.join(env.ProgramData, 'scoop'))
  ]
  return roots.flatMap((root) => {
    const folder = root ? cleanFolder(root) : null
    return folder ? [folder] : []
  })
}

/** What a Scoop app's manifest adds: its version, and the name and program of its first shortcut. */
export function scoopManifest(json: string): { version: string; name: string; program: string } {
  try {
    const data = JSON.parse(json) as { version?: unknown; shortcuts?: unknown }
    const first = Array.isArray(data.shortcuts) && Array.isArray(data.shortcuts[0]) ? data.shortcuts[0] : []
    return { version: text(data.version), program: text(first[0]), name: text(first[1]) }
  } catch {
    return { version: '', name: '', program: '' }
  }
}

/**
 * Apps Scoop installed. Each app's folder holds its versions and a `current` link to one of them, so
 * measuring it counts every version kept once.
 */
async function scoopApps(roots: string[]): Promise<AppEntry[]> {
  const apps: AppEntry[] = []
  for (const root of roots) {
    const appsFolder = path.win32.join(root, 'apps')
    let names: string[]
    try {
      names = await fs.readdir(nativePath(appsFolder))
    } catch {
      continue
    }
    await forEachConcurrent(names, 8, async (id) => {
      const folder = path.win32.join(appsFolder, id)
      const current = path.win32.join(folder, 'current')
      let json: string
      try {
        const file = nativePath(path.win32.join(current, 'manifest.json'))
        if ((await fs.stat(file)).size > MAX_MANIFEST_BYTES) return
        json = await fs.readFile(file, 'utf8')
      } catch {
        // Without a current version the app is broken or half removed.
        return
      }
      const manifest = scoopManifest(json)
      const program = manifest.program && cleanFolder(path.win32.join(current, manifest.program))
      apps.push({
        name: manifest.name || id,
        version: manifest.version,
        publisher: '',
        source: 'scoop',
        footprint: { kind: 'folder', path: folder },
        estimate: null,
        installedAt: 0,
        icon: program && within(current, program) && /\.exe$/i.test(program) ? { kind: 'file', path: program } : null
      })
    })
  }
  return apps
}

/**
 * The icon a DisplayIcon names: an executable, optionally with an icon index (`"app.exe",0`), or an
 * icon file. Environment variables in it are expanded; anything not on a local drive is ignored.
 */
export function displayIcon(raw: unknown, env: NodeJS.ProcessEnv = process.env): IconSource | null {
  const value = text(raw).replace(/%([^%]+)%/g, (match, name: string) => env[name] ?? match)
  const match = /^"?([A-Za-z]:[\\/][^"]*?\.(exe|ico))"?(?:\s*,\s*-?\d+)?$/i.exec(value)
  const file = match && cleanFolder(match[1])
  if (!file) return null
  return { kind: match[2].toLowerCase() === 'ico' ? 'image' : 'file', path: file }
}

/**
 * The icon Settings > Apps shows for a registered program: its DisplayIcon, else the icon Windows
 * Installer cached for it, else its uninstaller's, which installers such as Squirrel give the app's icon.
 */
export function registryIcon(
  row: RegistryRow,
  folders: WindowsFolders,
  env: NodeJS.ProcessEnv = process.env
): IconSource | null {
  const shown = displayIcon(row.DisplayIcon, env)
  if (shown) return shown
  // Cached icons are icon files or executables, often saved without an extension.
  const cached = cleanFolder(row.ProductIcon)
  if (cached && within(path.win32.join(folders.windows, 'Installer'), cached)) {
    return { kind: /\.exe$/i.test(cached) ? 'file' : 'image', path: cached }
  }
  // Uninstallers named as such (unins000.exe, uninstall.exe, setup.exe) carry the installer's icon instead.
  const uninstaller = executableOf(row.UninstallString)
  if (!uninstaller || within(folders.windows, uninstaller)) return null
  const name = path.win32.basename(uninstaller)
  if (/^(unins|setup)/i.test(name)) return null
  // Squirrel's Update.exe has no icon of its own; Squirrel saves the app's next to it.
  if (/^update\.exe$/i.test(name))
    return { kind: 'image', path: path.win32.join(path.win32.dirname(uninstaller), 'app.ico') }
  return { kind: 'file', path: uninstaller }
}

function installDate(raw: unknown): number {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(text(raw))
  if (!match) return 0
  const [year, month, day] = match.slice(1).map(Number)
  if (year < 1990 || month < 1 || month > 12 || day < 1 || day > 31) return 0
  return new Date(year, month - 1, day).getTime()
}

/** The organization in a package publisher such as `CN=Contoso, O=Contoso Ltd., C=US`. */
export function publisherName(raw: unknown): string {
  const value = text(raw)
  const field = (name: string) => new RegExp(`(?:^|,)\\s*${name}=("?)([^,"]+)\\1`).exec(value)?.[2]?.trim()
  const name = field('O') ?? field('CN') ?? ''
  // Store-signed packages from individual developers carry a GUID instead.
  return /^[0-9A-F]{8}-([0-9A-F]{4}-){3}[0-9A-F]{12}$/i.test(name) ? '' : name
}

function isUpdate(row: RegistryRow, name: string): boolean {
  if (text(row.ParentKeyName)) return true
  if (/update|hotfix|service pack/i.test(text(row.ReleaseType))) return true
  return /\bKB\d{6,}\b/.test(name)
}

function rows<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value.filter((row) => row && typeof row === 'object')
  // PowerShell writes a one-item list as the item itself.
  return value && typeof value === 'object' ? [value as T] : []
}

export function parseWindowsApps(data: WindowsAppData, folders: WindowsFolders): AppEntry[] {
  const apps: AppEntry[] = []
  for (const row of rows<RegistryRow>(data.Registry)) {
    const name = text(row.DisplayName)
    if (!name || Number(row.SystemComponent) === 1 || isUpdate(row, name)) continue
    const registered = cleanFolder(row.InstallLocation)
    // Some installers register their own cache, such as NVIDIA's Installer2, as the program's folder.
    const usable = registered && isAppFolder(registered, folders) && !inInstallerFolder(registered)
    const folder = usable ? registered : inferFolder(row, folders)
    const kib = Number(row.EstimatedSize)
    apps.push({
      name,
      version: text(row.DisplayVersion),
      publisher: text(row.Publisher),
      source: 'desktop',
      footprint: folder ? { kind: 'folder', path: folder } : null,
      estimate: Number.isFinite(kib) && kib > 0 ? kib * 1024 : null,
      installedAt: installDate(row.InstallDate),
      icon: registryIcon(row, folders)
    })
  }
  for (const row of rows<StoreRow>(data.Store)) {
    const name = text(row.StartName) || text(row.ManifestName) || text(row.Name)
    const folder = cleanFolder(row.InstallLocation)
    if (!name || !folder || row.External === true || !isAppFolder(folder, folders)) continue
    const logo = typeof row.Logo === 'string' ? packagePath(row.Logo) : null
    apps.push({
      name,
      version: text(row.Version),
      publisher: publisherName(row.Publisher),
      source: 'store',
      footprint: { kind: 'folder', path: folder },
      estimate: null,
      installedAt: 0,
      icon: logo ? { kind: 'store', folder, logo } : null
    })
  }
  return apps
}

/**
 * What a package manifest adds: its display name, unless that is a resource reference, whether it is
 * sparse, and its logo: the app list icon of its first app, else the package's store logo.
 */
export function manifestInfo(xml: string): { name: string; external: boolean; logo: string } {
  const properties = /<Properties>([\s\S]*?)<\/Properties>/.exec(xml)?.[1] ?? ''
  const name = decodeXml(/<DisplayName>([^<]*)<\/DisplayName>/.exec(properties)?.[1] ?? '').trim()
  const listIcon = /<(?:\w+:)?VisualElements\b[^>]*?\sSquare44x44Logo="([^"]*)"/.exec(xml)?.[1]
  const storeLogo = /<Logo>([^<]*)<\/Logo>/.exec(properties)?.[1]
  return {
    name: name.startsWith('ms-resource:') ? '' : name,
    external: /<(?:\w+:)?AllowExternalContent>\s*true\s*</.test(properties),
    logo: decodeXml(listIcon ?? storeLogo ?? '').trim()
  }
}

async function addManifests(store: unknown): Promise<void> {
  await forEachConcurrent(rows<StoreRow>(store), 8, async (row) => {
    const folder = cleanFolder(row.InstallLocation)
    if (!folder) return
    try {
      const file = nativePath(path.win32.join(folder, 'AppxManifest.xml'))
      if ((await fs.stat(file)).size > MAX_MANIFEST_BYTES) return
      const info = manifestInfo(await fs.readFile(file, 'utf8'))
      row.ManifestName = info.name
      row.External = info.external
      row.Logo = info.logo
    } catch {
      /* named after the package */
    }
  })
}

/** Where Steam and the Epic Games Launcher keep their records, from the registry and their defaults. */
export function gameLibrariesOf(data: WindowsAppData, env: NodeJS.ProcessEnv = process.env): GameLibraries {
  const list = (value: unknown) =>
    (Array.isArray(value) ? value : [value]).flatMap((v) => {
      const folder = cleanFolder(v)
      return folder ? [folder] : []
    })
  const x86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const programData = env.ProgramData || 'C:\\ProgramData'
  const unique = (folders: string[]) => [...new Map(folders.map((f) => [f.toLowerCase(), f])).values()]
  return {
    steamRoots: unique([...list(data.Steam), path.win32.join(x86, 'Steam')]),
    epicManifests: unique(
      [...list(data.Epic), path.win32.join(programData, 'Epic', 'EpicGamesLauncher', 'Data')].map((folder) =>
        path.win32.join(folder, 'Manifests')
      )
    ),
    // Heroic keeps its files in %APPDATA%; Legendary on its own in ~\.config, as elsewhere.
    ...heroicFiles(
      [env.APPDATA, env.USERPROFILE && path.win32.join(env.USERPROFILE, '.config')].filter((f): f is string =>
        Boolean(f)
      ),
      path.win32
    )
  }
}

export async function discoverWindowsApps(): Promise<AppEntry[]> {
  // Encoded, the script reaches PowerShell without any quoting for the command line to undo.
  const { stdout } = await execFileAsync(
    powershellPath(),
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(WINDOWS_APPS_SCRIPT, 'utf16le').toString('base64')
    ],
    { windowsHide: true, timeout: 60000, maxBuffer: 32 * 1024 * 1024 }
  )
  const parsed: unknown = JSON.parse(stdout.replace(/^\uFEFF/, '') || '{}')
  const data: WindowsAppData = parsed && typeof parsed === 'object' ? parsed : {}
  await addManifests(data.Store)
  const folders = windowsFolders()
  const [launcherGames, scoop] = await Promise.all([
    discoverGames(gameLibrariesOf(data), {
      path: path.win32,
      icon: (folder, executable) =>
        /\.exe$/i.test(executable) ? { kind: 'file', path: path.win32.join(folder, executable) } : null
    }),
    scoopApps(scoopRoots())
  ])
  const games = [...launcherGames, ...gogApps(data.Gog, folders)]
  // A launcher may register the folder its games install into, as the Epic Games Launcher does.
  folders.shared.push(...gameLibraryFolders(games, path.win32))
  // Scoop, launchers and GOG each know their apps better than the uninstall entries some of them add.
  const registered = mergeGames(mergeGames(parseWindowsApps(data, folders), scoop, true), games, true)
  // Shortcuts last: they only add programs in folders nothing else listed.
  const build = /^\d+\.\d+\.(\d+)/.exec(text(data.SystemVersion))?.[1] ?? os.release().split('.')[2] ?? null
  const apps = shortcutApps(data.Shortcuts, folders, registered, build)
  // Without a recorded date, the folder's creation is when the app arrived.
  await forEachConcurrent(apps, 8, async (app) => {
    if (app.installedAt || app.footprint?.kind !== 'folder') return
    try {
      app.installedAt = (await fs.stat(nativePath(app.footprint.path))).birthtimeMs
    } catch {
      /* measured, or reported missing, later */
    }
  })
  return apps
}
