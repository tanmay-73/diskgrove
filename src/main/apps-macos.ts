import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import type { AppEntry } from './apps'
import { discoverGames, heroicFiles, mergeGames } from './apps-games'
import { discoverHomebrew, homebrewPrefixes } from './apps-homebrew'
import { forEachConcurrent } from './concurrency'
import { fs } from './real-fs'
import { decodeXml } from './xml'

const execFileAsync = promisify(execFile)

const MAX_PLIST_BYTES = 1024 * 1024
// /Applications/Utilities/Tool.app and /Applications/Vendor Suite/Tool.app sit one folder down.
const MAX_FOLDER_DEPTH = 2

/** The string values of the top-level dictionary of an XML property list. Nested values are skipped. */
export function plistStrings(xml: string): Map<string, string> {
  const values = new Map<string, string>()
  const tag = /<(\/?)([A-Za-z]+)\b[^>]*?(\/?)>/g
  let depth = 0
  let key: string | null = null
  for (let match = tag.exec(xml); match; match = tag.exec(xml)) {
    const [, closing, name, empty] = match
    if (name === 'dict' || name === 'array') {
      // A nested dictionary or array is the value of the pending key.
      if (depth === 1 && !closing) key = null
      if (!empty) depth += closing ? -1 : 1
      continue
    }
    if (closing || depth !== 1) continue
    if (name !== 'key' && name !== 'string') {
      key = null
      continue
    }
    let value = ''
    if (!empty) {
      const end = xml.indexOf(`</${name}>`, tag.lastIndex)
      if (end === -1) break
      value = decodeXml(xml.slice(tag.lastIndex, end))
      tag.lastIndex = end + name.length + 3
    }
    if (name === 'key') {
      key = value
    } else if (key !== null) {
      if (!values.has(key)) values.set(key, value)
      key = null
    }
  }
  return values
}

async function bundleInfo(bundle: string): Promise<Map<string, string>> {
  const file = path.join(bundle, 'Contents', 'Info.plist')
  try {
    const stats = await fs.stat(file)
    if (!stats.isFile() || stats.size > MAX_PLIST_BYTES) return new Map()
    const data = await fs.readFile(file)
    if (data.subarray(0, 6).toString('latin1') !== 'bplist') return plistStrings(data.toString('utf8'))
    // Apple's own bundles use the binary format; plutil turns it into XML without running anything else.
    const { stdout } = await execFileAsync('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', file], {
      timeout: 5000,
      maxBuffer: 4 * MAX_PLIST_BYTES
    })
    return plistStrings(stdout)
  } catch {
    return new Map()
  }
}

async function findBundles(
  folder: string,
  depth: number,
  maxDepth: number,
  bundles: string[],
  links: string[]
): Promise<void> {
  let entries
  try {
    entries = await fs.readdir(folder, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const child = path.join(folder, entry.name)
    const isBundle = entry.name.toLowerCase().endsWith('.app')
    // Links to bundles, as Nix and older Homebrew casks make, are resolved later; others are not followed.
    if (entry.isSymbolicLink() && isBundle) links.push(child)
    if (!entry.isDirectory()) continue
    if (isBundle) bundles.push(child)
    else if (depth < maxDepth) await findBundles(child, depth + 1, maxDepth, bundles, links)
  }
}

/**
 * The bundles links point to, when those are not found anyway. Bundles on the system volume are
 * part of macOS, and are left out as in /System/Applications.
 */
async function linkedBundles(links: string[], found: string[]): Promise<string[]> {
  const known = new Set(found)
  const targets: string[] = []
  for (const link of links) {
    try {
      const real = await fs.realpath(link)
      if (known.has(real) || real.startsWith('/System/') || !(await fs.stat(real)).isDirectory()) continue
      known.add(real)
      targets.push(real)
    } catch {
      /* a broken link */
    }
  }
  return targets
}

/**
 * Where bundles are kept, and how many folders down: the Applications folders hold vendors' folders,
 * while apps run from Downloads or the Desktop, or shared between users, sit at the top.
 */
export function bundleRoots(home: string): Array<[string, number]> {
  return [
    ['/Applications', MAX_FOLDER_DEPTH],
    [path.posix.join(home, 'Applications'), MAX_FOLDER_DEPTH],
    ['/Users/Shared', 1],
    [path.posix.join(home, 'Downloads'), 1],
    [path.posix.join(home, 'Desktop'), 1]
  ]
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file)
    return true
  } catch {
    return false
  }
}

/**
 * App bundles in the Applications folders and the other places bundleRoots names, games Steam and Epic
 * installed elsewhere, and formulae installed with Homebrew. Apps in /System/Applications belong to the
 * read-only system volume and cannot be removed, so they are left out.
 */
export async function discoverMacApps(home: string): Promise<AppEntry[]> {
  const bundles: string[] = []
  const links: string[] = []
  for (const [root, depth] of bundleRoots(home)) await findBundles(root, 1, depth, bundles, links)
  bundles.push(...(await linkedBundles(links, bundles)))
  const apps: AppEntry[] = []
  await forEachConcurrent(bundles, 8, async (bundle) => {
    const [info, fromAppStore, stats] = await Promise.all([
      bundleInfo(bundle),
      exists(path.join(bundle, 'Contents', '_MASReceipt', 'receipt')),
      fs.lstat(bundle).catch(() => null)
    ])
    apps.push({
      // Finder shows the bundle's file name.
      name: path.basename(bundle).replace(/\.app$/i, ''),
      version: info.get('CFBundleShortVersionString') || info.get('CFBundleVersion') || '',
      publisher: '',
      source: fromAppStore ? 'appstore' : 'app',
      footprint: { kind: 'folder', path: bundle },
      estimate: null,
      // Copying or updating a bundle creates its folder anew; its creation date can be the build's.
      installedAt: stats?.ctimeMs ?? 0,
      // Finder's icon for the bundle, drawn by the system from the bundle's own resources.
      icon: { kind: 'file', path: bundle }
    })
  })
  // Steam and Epic install games outside Applications, each game a folder holding its app bundle.
  const support = path.join(home, 'Library', 'Application Support')
  const games = await discoverGames(
    {
      steamRoots: [path.join(support, 'Steam')],
      epicManifests: [path.join(support, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests')],
      // Heroic keeps its files in Application Support; Legendary on its own in ~/.config.
      ...heroicFiles([support, path.join(home, '.config')], path.posix)
    },
    { path: path.posix, icon: gameBundleIcon }
  )
  // A game's bundle found in a folder searched above is part of the game, which is measured whole.
  const gameFolders = games.flatMap((g) => (g.footprint?.kind === 'folder' ? [g.footprint.path.toLowerCase()] : []))
  const outside = apps.filter((app) => {
    const bundle = app.footprint?.kind === 'folder' ? app.footprint.path.toLowerCase() : ''
    return !gameFolders.some((folder) => bundle.startsWith(`${folder}/`))
  })
  const brew = await discoverHomebrew(homebrewPrefixes('darwin', home, process.env))
  return [...mergeGames(outside, games, true), ...brew]
}

/** The app bundle an Epic game's executable is inside (`Game.app/Contents/MacOS/Game`), for its icon. */
function gameBundleIcon(folder: string, executable: string): { kind: 'file'; path: string } | null {
  const match = /^(.*?\.app)(?:\/|$)/i.exec(executable)
  return match ? { kind: 'file', path: path.posix.join(folder, match[1]) } : null
}
