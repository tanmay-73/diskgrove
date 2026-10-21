import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AppSettings, RecentScan, SearchScope } from '@shared/types'
import { isThemeMode } from '@shared/themes'
import { DEFAULT_FONT_SCALE, isFontScale } from '@shared/font-scale'

const DEFAULTS: AppSettings = {
  theme: 'dark',
  followLinks: false,
  skipHidden: false,
  showFreeSpace: true,
  showPreview: true,
  fontScale: DEFAULT_FONT_SCALE,
  searchScope: 'folder',
  recents: []
}

const MAX_RECENTS = 12
const MAX_PATH_LENGTH = 32767

function filePath(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

let cache: AppSettings | null = null

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSearchScope(value: unknown): value is SearchScope {
  return value === 'folder' || value === 'all'
}

function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function sanitizeRecents(value: unknown): RecentScan[] {
  if (!Array.isArray(value)) return []
  const out: RecentScan[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!isRecord(item)) continue
    const p = item.path
    if (typeof p !== 'string' || p.length === 0 || p.length > MAX_PATH_LENGTH || p.includes('\0')) continue
    const key = p
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      path: p,
      scannedAt: nonNegative(item.scannedAt),
      size: nonNegative(item.size),
      files: nonNegative(item.files)
    })
    if (out.length >= MAX_RECENTS) break
  }
  return out
}

export function sanitizeSettings(input: unknown, base: AppSettings): AppSettings {
  const src = isRecord(input) ? input : {}
  return {
    theme: isThemeMode(src.theme) ? src.theme : base.theme,
    followLinks: typeof src.followLinks === 'boolean' ? src.followLinks : base.followLinks,
    skipHidden: typeof src.skipHidden === 'boolean' ? src.skipHidden : base.skipHidden,
    showFreeSpace: typeof src.showFreeSpace === 'boolean' ? src.showFreeSpace : base.showFreeSpace,
    showPreview: typeof src.showPreview === 'boolean' ? src.showPreview : base.showPreview,
    fontScale: isFontScale(src.fontScale) ? src.fontScale : base.fontScale,
    searchScope: isSearchScope(src.searchScope) ? src.searchScope : base.searchScope,
    recents: src.recents === undefined ? base.recents : sanitizeRecents(src.recents)
  }
}

export async function loadSettings(): Promise<AppSettings> {
  if (cache) return cache
  let next: AppSettings
  try {
    const raw = await fs.readFile(filePath(), 'utf8')
    next = sanitizeSettings(JSON.parse(raw), DEFAULTS)
  } catch {
    next = { ...DEFAULTS }
  }
  cache = next
  return next
}

let pendingSave: Promise<unknown> = Promise.resolve()

export function saveSettings(partial: unknown): Promise<AppSettings> {
  const save = pendingSave.then(() => writeSettings(partial))
  pendingSave = save.catch(() => undefined)
  return save
}

async function writeSettings(partial: unknown): Promise<AppSettings> {
  const current = await loadSettings()
  const next = sanitizeSettings(partial, current)

  // Rename only after the complete settings file has been written.
  const target = filePath()
  const tmp = `${target}.${randomUUID()}.tmp`
  await fs.mkdir(path.dirname(target), { recursive: true })
  try {
    await fs.writeFile(tmp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await fs.rename(tmp, target)
    cache = next
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
  }
  return next
}
