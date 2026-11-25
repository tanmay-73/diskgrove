import path from 'node:path'
import { isWithin } from '@shared/paths'
import { nativePath } from './disk-usage'
import { fs } from './real-fs'

/**
 * Where an app's icon comes from. Found while listing, it is only turned into an image when the
 * window shows the app.
 * - file: the icon the system shows for an executable or app bundle.
 * - image: a PNG, JPEG, ICO or SVG file. Without an extension, its first bytes say which it is.
 * - store: a Microsoft Store package logo, a path relative to the package folder that names a set
 *   of files with scale and size qualifiers (`Logo.scale-200.png`, `Logo.targetsize-48.png`).
 * - theme: a Linux icon name, looked up in the hicolor theme and pixmaps of each data folder.
 */
export type IconSource =
  | { kind: 'file'; path: string }
  | { kind: 'image'; path: string }
  | { kind: 'store'; folder: string; logo: string }
  | { kind: 'theme'; name: string; dirs: string[] }

/** An icon found on disk: an image file, or a file whose system icon is the app's. */
export type IconFile = { kind: 'file' | 'image'; path: string }

const MAX_IMAGE_BYTES = 4 * 1024 * 1024
const MAX_SVG_BYTES = 1024 * 1024
const IMAGE = /\.(png|jpe?g|ico|svg)$/i

// Rows show icons at 24 px, 48 px on high-density screens; sizes closest to that are tried first.
const THEME_SIZES = ['48x48', '64x64', '96x96', '128x128', 'scalable', '256x256', '512x512', '32x32', '24x24']
const THEME_NAME = /^[\w.+@-]+$/

async function isImage(file: string): Promise<boolean> {
  if (!IMAGE.test(file) && /\.[^.\\/]*$/.test(file)) return false
  try {
    const stats = await fs.stat(nativePath(file))
    return stats.isFile() && stats.size > 0 && stats.size <= (/\.svg$/i.test(file) ? MAX_SVG_BYTES : MAX_IMAGE_BYTES)
  } catch {
    return false
  }
}

/**
 * What an image file holds, from its first bytes; SVG only when it is named so. Anything else, such as
 * an executable saved as an icon, is not drawn from its bytes.
 */
export function imageType(file: string, data: Uint8Array): 'png' | 'jpeg' | 'ico' | 'svg' | null {
  const starts = (...bytes: number[]) => bytes.every((byte, i) => data[i] === byte)
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png'
  if (starts(0xff, 0xd8, 0xff)) return 'jpeg'
  if (starts(0x00, 0x00, 0x01, 0x00) && data.length > 6) return 'ico'
  return /\.svg$/i.test(file) ? 'svg' : null
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(nativePath(file))
    return true
  } catch {
    return false
  }
}

/** A package-relative path from a manifest, or null when it is absolute or leaves the package. */
export function packagePath(raw: string): string | null {
  const value = raw.trim().replace(/\//g, '\\')
  if (!value || value.includes('\0') || /^[A-Za-z]:|^\\/.test(value)) return null
  const normalized = path.win32.normalize(value)
  return normalized.split('\\').some((segment) => segment === '..') ? null : normalized
}

/**
 * The best of a logo's variants in its folder: a target size near 48 px, unplated (drawn for a
 * transparent background) where offered, then the scale nearest 200%. High-contrast variants are
 * a last resort.
 */
export function pickLogo(files: string[], logo: string): string | null {
  const ext = path.win32.extname(logo).toLowerCase()
  const stem = path.win32.basename(logo, path.win32.extname(logo)).toLowerCase()
  let best: string | null = null
  let bestScore = Infinity
  for (const file of files) {
    const lower = file.toLowerCase()
    if (!lower.endsWith(ext)) continue
    let qualifiers: string[]
    if (lower === stem + ext) qualifiers = []
    else if (lower.startsWith(`${stem}.`)) qualifiers = lower.slice(stem.length + 1, -ext.length).split('_')
    else continue
    let score = 30
    for (const q of qualifiers) {
      const target = /^targetsize-(\d+)$/.exec(q)
      const scale = /^scale-(\d+)$/.exec(q)
      if (target) score = Math.abs(Number(target[1]) - 48) / 4
      else if (scale) score = 10 + Math.abs(Number(scale[1]) - 200) / 50
      else if (q.startsWith('contrast-')) score += 1000
    }
    if (qualifiers.includes('altform-unplated')) score -= 1
    else if (qualifiers.some((q) => q.startsWith('altform-'))) score += 0.5
    if (score < bestScore) {
      best = file
      bestScore = score
    }
  }
  return best
}

async function storeLogo(folder: string, logo: string): Promise<IconFile | null> {
  const dir = path.win32.join(folder, path.win32.dirname(logo))
  if (!isWithin(folder.toLowerCase(), dir.toLowerCase())) return null
  let files: string[]
  try {
    files = await fs.readdir(nativePath(dir))
  } catch {
    return null
  }
  const file = pickLogo(files, logo)
  const full = file && path.win32.join(dir, file)
  return full && (await isImage(full)) ? { kind: 'image', path: full } : null
}

/** A Linux desktop entry's Icon value: an image file, or a name to look up in the icon theme. */
export function linuxIcon(raw: string, dirs: string[]): IconSource | null {
  const value = raw.trim()
  if (value.startsWith('/')) return IMAGE.test(value) ? { kind: 'image', path: path.posix.normalize(value) } : null
  // Older entries name the file in pixmaps, extension included.
  const name = value.replace(/\.(png|svg|xpm)$/i, '')
  if (!THEME_NAME.test(name) || name === '.' || name === '..') return null
  return { kind: 'theme', name, dirs }
}

async function themeIcon(name: string, dirs: string[]): Promise<IconFile | null> {
  const candidates = [
    ...dirs.flatMap((dir) =>
      THEME_SIZES.flatMap((size) =>
        ['png', 'svg'].map((ext) => path.posix.join(dir, 'icons', 'hicolor', size, 'apps', `${name}.${ext}`))
      )
    ),
    ...dirs.flatMap((dir) => ['png', 'svg'].map((ext) => path.posix.join(dir, 'pixmaps', `${name}.${ext}`)))
  ]
  for (const file of candidates) if (await isImage(file)) return { kind: 'image', path: file }
  return null
}

/** The file to draw an app's icon from, or null when there is none. */
export async function resolveIcon(source: IconSource): Promise<IconFile | null> {
  switch (source.kind) {
    case 'file':
      return (await exists(source.path)) ? source : null
    case 'image':
      return (await isImage(source.path)) ? source : null
    case 'store':
      return storeLogo(source.folder, source.logo)
    case 'theme':
      return themeIcon(source.name, source.dirs)
  }
}
