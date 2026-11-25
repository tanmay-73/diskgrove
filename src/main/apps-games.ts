import nodePath from 'node:path'
import type { IconSource } from './app-icons'
import type { AppEntry } from './apps'
import { forEachConcurrent } from './concurrency'
import { nativePath } from './disk-usage'
import { fs } from './real-fs'

// Game launchers keep their own records of what they installed, which the system's lists of installed
// programs do not include: Epic writes no uninstall entry at all, and Steam does not always write one.

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024

type PathApi = typeof nodePath.posix

/** A node of a Valve KeyValues (VDF) text file: a string, or a block of named nodes. */
export type VdfNode = string | { [key: string]: VdfNode }

/** Parses Valve's KeyValues text format, as in libraryfolders.vdf and appmanifest_*.acf. */
export function parseVdf(text: string): { [key: string]: VdfNode } {
  const tokens: Array<{ kind: 'string' | 'open' | 'close'; value: string }> = []
  for (let i = 0; i < text.length;) {
    const c = text[i]
    if (/\s/.test(c)) {
      i++
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (c === '{' || c === '}') {
      tokens.push({ kind: c === '{' ? 'open' : 'close', value: c })
      i++
    } else if (c === '"') {
      let value = ''
      for (i++; i < text.length && text[i] !== '"'; i++) {
        if (text[i] === '\\' && i + 1 < text.length) {
          const next = text[++i]
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next
        } else {
          value += text[i]
        }
      }
      tokens.push({ kind: 'string', value })
      i++
    } else {
      let value = ''
      while (i < text.length && !/[\s{}"]/.test(text[i])) value += text[i++]
      tokens.push({ kind: 'string', value })
    }
  }
  let at = 0
  const block = (): { [key: string]: VdfNode } => {
    const node: { [key: string]: VdfNode } = {}
    while (at < tokens.length) {
      const key = tokens[at++]
      if (key.kind === 'close') break
      if (key.kind !== 'string') continue
      const value = tokens[at++]
      if (!value) break
      const child = value.kind === 'open' ? block() : value.kind === 'string' ? value.value : null
      if (child === null) break
      // Keys ignore case in Valve's own reader; later duplicates do not replace the first.
      const name = key.value.toLowerCase()
      if (!(name in node)) node[name] = child
    }
    return node
  }
  return block()
}

function blockOf(node: VdfNode | undefined): { [key: string]: VdfNode } | null {
  return node && typeof node === 'object' ? node : null
}

function str(node: VdfNode | undefined): string {
  return typeof node === 'string' ? node.trim() : ''
}

/** The library folders a libraryfolders.vdf lists, in the current format and the older one. */
export function steamLibraries(vdf: string): string[] {
  const root = blockOf(parseVdf(vdf).libraryfolders)
  if (!root) return []
  const found: string[] = []
  for (const [key, value] of Object.entries(root)) {
    if (!/^\d+$/.test(key)) continue
    // Old files list `"1" "D:\\SteamLibrary"`; new ones a block with a `path` key.
    const folder = typeof value === 'string' ? value.trim() : str(value.path)
    if (folder) found.push(folder)
  }
  return found
}

export interface SteamManifest {
  appId: string
  name: string
  installDir: string
  sizeOnDisk: number
  lastUpdated: number
  buildId: string
}

/** The fields of an appmanifest_<id>.acf that describe an installed game. */
export function parseSteamManifest(acf: string): SteamManifest | null {
  const state = blockOf(parseVdf(acf).appstate)
  if (!state) return null
  const appId = str(state.appid)
  const installDir = str(state.installdir)
  // An install folder is one name inside steamapps/common.
  // Windows drops trailing dots and spaces, so a name of only those would be steamapps/common itself.
  if (!/^\d+$/.test(appId) || /[\\/]/.test(installDir) || /^[.\s]*$/.test(installDir)) {
    return null
  }
  const size = Number(str(state.sizeondisk))
  const updated = Number(str(state.lastupdated))
  return {
    appId,
    name: str(state.name) || installDir,
    installDir,
    sizeOnDisk: Number.isFinite(size) && size > 0 ? size : 0,
    lastUpdated: Number.isFinite(updated) && updated > 0 ? updated * 1000 : 0,
    buildId: str(state.buildid)
  }
}

export interface EpicManifest {
  name: string
  version: string
  folder: string
  size: number
  /** The executable, relative to the install folder. */
  executable: string
}

/** An Epic Games Launcher manifest (`Data/Manifests/*.item`), or null for add-ons and non-games. */
export function parseEpicManifest(json: string): EpicManifest | null {
  let data: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(json)
    if (!parsed || typeof parsed !== 'object') return null
    data = parsed as Record<string, unknown>
  } catch {
    return null
  }
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const folder = text(data.InstallLocation)
  const name = text(data.DisplayName)
  if (!folder || !name) return null
  // Add-ons install into their game's folder and name it as their main game.
  const main = text(data.MainGameAppName)
  if (main && main !== text(data.AppName)) return null
  const size = Number(data.InstallSize)
  return {
    name,
    version: text(data.AppVersionString),
    folder,
    size: Number.isFinite(size) && size > 0 ? size : 0,
    executable: text(data.LaunchExecutable)
  }
}

/** Games Legendary (and Heroic, which runs it) installed, from its installed.json. */
export function parseLegendaryInstalled(json: string): EpicManifest[] {
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    return []
  }
  if (!data || typeof data !== 'object') return []
  const games: EpicManifest[] = []
  for (const value of Object.values(data as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const game = value as Record<string, unknown>
    const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
    const folder = text(game.install_path)
    const name = text(game.title)
    if (!folder || !name || game.is_dlc === true) continue
    const size = Number(game.install_size)
    games.push({
      name,
      version: text(game.version),
      folder,
      size: Number.isFinite(size) && size > 0 ? size : 0,
      executable: text(game.executable)
    })
  }
  return games
}

async function readSmall(file: string): Promise<string | null> {
  try {
    const native = nativePath(file)
    const stats = await fs.stat(native)
    if (!stats.isFile() || stats.size > MAX_MANIFEST_BYTES) return null
    return await fs.readFile(native, 'utf8')
  } catch {
    return null
  }
}

async function isFolder(folder: string): Promise<boolean> {
  try {
    return (await fs.stat(nativePath(folder))).isDirectory()
  } catch {
    return false
  }
}

async function birthOf(folder: string): Promise<number> {
  try {
    const stats = await fs.stat(nativePath(folder))
    return stats.birthtimeMs || stats.mtimeMs
  } catch {
    return 0
  }
}

/** How a platform names the files of a launcher game. */
export interface GamePlatform {
  path: PathApi
  /** The icon to show for a game's executable, relative to its folder; null when there is none. */
  icon?: (folder: string, executable: string) => IconSource | null
  /** Icons for Steam games by app ID, such as the ones Steam's menu shortcuts name on Linux. */
  steamIcons?: Map<string, IconSource>
}

export interface GameLibraries {
  /** Steam installs: folders holding steamapps/libraryfolders.vdf. */
  steamRoots: string[]
  /** Folders of Epic Games Launcher manifests (`*.item`). */
  epicManifests: string[]
  /** Legendary installed.json files. */
  legendary: string[]
  /** Heroic's gog_store/installed.json files. */
  heroicGog?: string[]
}

/** Heroic and Legendary keep their files in the same places relative to the user's config folder. */
export function heroicFiles(configFolders: string[], p: PathApi): Pick<GameLibraries, 'legendary' | 'heroicGog'> {
  return {
    legendary: configFolders.flatMap((config) => [
      p.join(config, 'legendary', 'installed.json'),
      p.join(config, 'heroic', 'legendaryConfig', 'legendary', 'installed.json')
    ]),
    heroicGog: configFolders.map((config) => p.join(config, 'heroic', 'gog_store', 'installed.json'))
  }
}

/** GOG games Heroic installed. Its record has no title, but the folder is named after the game. */
export function parseHeroicGog(json: string, p: PathApi): EpicManifest[] {
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    return []
  }
  const installed = data && typeof data === 'object' ? (data as { installed?: unknown }).installed : null
  if (!Array.isArray(installed)) return []
  return installed.flatMap((value): EpicManifest[] => {
    if (!value || typeof value !== 'object') return []
    const game = value as Record<string, unknown>
    const folder = typeof game.install_path === 'string' ? game.install_path.trim().replace(/[\\/]+$/, '') : ''
    if (!folder || game.is_dlc === true) return []
    return [
      {
        name: p.basename(folder),
        version: typeof game.version === 'string' ? game.version.trim() : '',
        folder,
        size: 0,
        executable: ''
      }
    ]
  })
}

/** The library folders of every Steam install, each once. */
async function steamLibraryFolders(roots: string[], p: PathApi): Promise<string[]> {
  const libraries = new Map<string, string>()
  const add = async (folder: string) => {
    const resolved = p.normalize(folder)
    const real = await fs.realpath(nativePath(resolved)).catch(() => null)
    if (!real) return
    const key = p === nodePath.win32 ? real.toLowerCase() : real
    if (!libraries.has(key)) libraries.set(key, resolved)
  }
  for (const root of roots) {
    await add(root)
    for (const file of [
      p.join(root, 'steamapps', 'libraryfolders.vdf'),
      p.join(root, 'config', 'libraryfolders.vdf')
    ]) {
      const vdf = await readSmall(file)
      if (vdf === null) continue
      for (const folder of steamLibraries(vdf)) if (p.isAbsolute(folder)) await add(folder)
    }
  }
  return [...libraries.values()]
}

async function steamGames(roots: string[], platform: GamePlatform): Promise<AppEntry[]> {
  const p = platform.path
  const games: AppEntry[] = []
  for (const library of await steamLibraryFolders(roots, p)) {
    const steamapps = p.join(library, 'steamapps')
    let names: string[]
    try {
      names = await fs.readdir(nativePath(steamapps))
    } catch {
      continue
    }
    await forEachConcurrent(
      names.filter((name) => /^appmanifest_\d+\.acf$/i.test(name)),
      8,
      async (name) => {
        const acf = await readSmall(p.join(steamapps, name))
        const manifest = acf === null ? null : parseSteamManifest(acf)
        if (!manifest) return
        const folder = p.join(steamapps, 'common', manifest.installDir)
        if (!(await isFolder(folder))) return
        games.push({
          name: manifest.name,
          version: manifest.buildId ? `Build ${manifest.buildId}` : '',
          publisher: '',
          source: 'steam',
          footprint: { kind: 'folder', path: folder },
          estimate: manifest.sizeOnDisk || null,
          installedAt: (await birthOf(folder)) || manifest.lastUpdated,
          icon: platform.steamIcons?.get(manifest.appId) ?? platform.icon?.(folder, '') ?? null
        })
      }
    )
  }
  return games
}

/** Games from launchers that record each game's folder: Epic, Legendary and Heroic's GOG library. */
async function recordedGames(libraries: GameLibraries, platform: GamePlatform): Promise<AppEntry[]> {
  const p = platform.path
  const manifests: Array<EpicManifest & { source?: 'gog' }> = []
  for (const folder of libraries.epicManifests) {
    let names: string[]
    try {
      names = await fs.readdir(nativePath(folder))
    } catch {
      continue
    }
    await forEachConcurrent(
      names.filter((name) => name.toLowerCase().endsWith('.item')),
      8,
      async (name) => {
        const json = await readSmall(p.join(folder, name))
        const manifest = json === null ? null : parseEpicManifest(json)
        if (manifest) manifests.push(manifest)
      }
    )
  }
  for (const file of libraries.legendary) {
    const json = await readSmall(file)
    if (json !== null) manifests.push(...parseLegendaryInstalled(json))
  }
  for (const file of libraries.heroicGog ?? []) {
    const json = await readSmall(file)
    if (json !== null) manifests.push(...parseHeroicGog(json, p).map((game) => ({ ...game, source: 'gog' as const })))
  }
  const games: AppEntry[] = []
  const seen = new Set<string>()
  await forEachConcurrent(manifests, 8, async (manifest) => {
    if (!p.isAbsolute(manifest.folder)) return
    const folder = p.normalize(manifest.folder).replace(/[\\/]+$/, '')
    const key = p === nodePath.win32 ? folder.toLowerCase() : folder
    if (seen.has(key) || p.parse(folder).root === folder || !(await isFolder(folder))) return
    seen.add(key)
    games.push({
      name: manifest.name,
      version: manifest.version,
      publisher: '',
      source: manifest.source ?? 'epic',
      footprint: { kind: 'folder', path: folder },
      estimate: manifest.size || null,
      installedAt: await birthOf(folder),
      icon: platform.icon?.(folder, manifest.executable) ?? null
    })
  })
  return games
}

/** Games installed by Steam, the Epic Games Launcher, Legendary and Heroic. */
export async function discoverGames(libraries: GameLibraries, platform: GamePlatform): Promise<AppEntry[]> {
  const [steam, epic] = await Promise.all([
    steamGames(libraries.steamRoots, platform),
    recordedGames(libraries, platform)
  ])
  return [...steam, ...epic]
}

/**
 * Folders that hold many games, so none can be one app's folder: the folder above each game's,
 * such as steamapps/common or Epic Games, which a launcher may register as its own.
 */
export function gameLibraryFolders(games: AppEntry[], p: PathApi): string[] {
  const folders = new Set<string>()
  for (const game of games) {
    if (game.footprint?.kind === 'folder') folders.add(p.dirname(game.footprint.path))
  }
  return [...folders]
}

/**
 * Adds launcher games to the system's list. A game the system also lists by its folder, as Steam
 * games often are on Windows, keeps that entry, takes the launcher's name for its source, and gains
 * the launcher's size figure when it had none.
 */
export function mergeGames(apps: AppEntry[], games: AppEntry[], ignoreCase: boolean): AppEntry[] {
  const key = (p: string) => (ignoreCase ? p.toLowerCase() : p)
  const byFolder = new Map<string, number>()
  apps.forEach((app, i) => {
    if (app.footprint?.kind === 'folder') byFolder.set(key(app.footprint.path), i)
  })
  const merged = [...apps]
  for (const game of games) {
    const folder = game.footprint?.kind === 'folder' ? key(game.footprint.path) : null
    const at = folder === null ? undefined : byFolder.get(folder)
    if (at === undefined) {
      if (folder !== null) byFolder.set(folder, merged.length)
      merged.push(game)
      continue
    }
    const app = merged[at]
    merged[at] = {
      ...app,
      source: game.source,
      version: app.version || game.version,
      estimate: app.estimate ?? game.estimate,
      installedAt: app.installedAt || game.installedAt,
      icon: app.icon ?? game.icon
    }
  }
  return merged
}
