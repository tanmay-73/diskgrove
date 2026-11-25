import { createHash } from 'node:crypto'
import os from 'node:os'
import { isWithin } from '@shared/paths'
import type { AppSource, AppsProgress, AppsResult, InstalledApp } from '@shared/types'
import type { IconSource } from './app-icons'
import { discoverLinuxApps } from './apps-linux'
import { discoverMacApps } from './apps-macos'
import { discoverWindowsApps } from './apps-windows'
import { forEachConcurrent } from './concurrency'
import { measureFiles, measureFolder, type Usage } from './disk-usage'

/** Where an app's files are: one folder, or the files a package manager lists for it. */
export type Footprint = { kind: 'folder'; path: string } | { kind: 'files'; paths: string[] }

/** An installed app as the platform lists it, before it is measured. */
export interface AppEntry {
  name: string
  version: string
  publisher: string
  source: AppSource
  /** The folder or file to show and reveal, when it is not the footprint's folder. */
  location?: string | null
  footprint: Footprint | null
  /** The installer's own size figure in bytes, for when the footprint cannot be measured. */
  estimate: number | null
  installedAt: number
  icon?: IconSource | null
}

export function discoverApps(): Promise<AppEntry[]> {
  if (process.platform === 'win32') return discoverWindowsApps()
  if (process.platform === 'darwin') return discoverMacApps(os.homedir())
  return discoverLinuxApps(os.homedir())
}

const PROGRESS_MS = 250
// Each folder is itself walked in parallel; more apps at once would only queue on the disk.
const MEASURE_CONCURRENCY = 3

// Windows and default macOS volumes ignore case, so two spellings can name one folder.
function folderKey(p: string): string {
  return process.platform === 'linux' ? p : p.toLowerCase()
}

function folderOf(entry: AppEntry): string | null {
  return entry.footprint?.kind === 'folder' ? entry.footprint.path : null
}

function appId(entry: AppEntry, location: string | null): string {
  return createHash('sha256')
    .update([entry.source, entry.name, location ?? '', entry.version].join('\0'))
    .digest('hex')
    .slice(0, 16)
}

function unmeasured(entry: AppEntry): Pick<InstalledApp, 'size' | 'allocated' | 'sizeKind' | 'partial'> {
  return entry.estimate !== null && entry.estimate > 0
    ? { size: entry.estimate, allocated: null, sizeKind: 'estimated', partial: false }
    : { size: null, allocated: null, sizeKind: 'unknown', partial: false }
}

function listed(entry: AppEntry): InstalledApp {
  const folder = folderOf(entry)
  const location = entry.location !== undefined ? entry.location : folder
  return {
    id: appId(entry, location),
    name: entry.name,
    version: entry.version,
    publisher: entry.publisher,
    source: entry.source,
    location,
    locationIsFolder: folder !== null && location === folder,
    ...(entry.footprint ? { size: null, allocated: null, sizeKind: 'pending', partial: false } : unmeasured(entry)),
    installedAt: entry.installedAt,
    insideOf: null,
    hasIcon: Boolean(entry.icon)
  }
}

/**
 * Marks apps measured inside another listed app's folder, such as an updater in its product's
 * folder, so a total counts those files once. Of two apps in one folder, the first holds the other.
 */
export function markNested(apps: InstalledApp[]): InstalledApp[] {
  const folders = apps.map((app) =>
    app.locationIsFolder && app.sizeKind === 'measured' && app.location ? folderKey(app.location) : null
  )
  return apps.map((app, i) => {
    const own = folders[i]
    if (own === null) return { ...app, insideOf: null }
    let outer = -1
    let outerLength = Infinity
    for (let j = 0; j < folders.length; j++) {
      const other = folders[j]
      if (other === null || j === i || !isWithin(other, own) || (other === own && j > i)) continue
      if (other.length < outerLength) {
        outer = j
        outerLength = other.length
      }
    }
    return { ...app, insideOf: outer === -1 ? null : apps[outer].name }
  })
}

function bySize(a: InstalledApp, b: InstalledApp): number {
  return (b.size ?? -1) - (a.size ?? -1) || a.name.localeCompare(b.name)
}

/** Lists installed apps and measures them, one listing at a time. */
export class AppCatalog {
  onProgress: ((p: AppsProgress) => void) | null = null
  private result: AppsResult | null = null
  private running: Promise<AppsResult> | null = null
  private cancelled = false
  private locations = new Map<string, string>()
  private icons = new Map<string, IconSource>()

  constructor(private readonly discover: () => Promise<AppEntry[]> = discoverApps) {}

  list(refresh: boolean): Promise<AppsResult> {
    if (this.running) return this.running
    if (this.result && !refresh) return Promise.resolve(this.result)
    this.cancelled = false
    this.running = this.collect().finally(() => {
      this.running = null
    })
    return this.running
  }

  cancel(): void {
    if (this.running) this.cancelled = true
  }

  /** The folder or file of an app in the latest list. Only these may be revealed. */
  locationOf(id: string): string | null {
    return this.locations.get(id) ?? null
  }

  /** Where the icon of an app in the latest list comes from. */
  iconOf(id: string): IconSource | null {
    return this.icons.get(id) ?? null
  }

  private async collect(): Promise<AppsResult> {
    this.onProgress?.({ phase: 'listing', measured: 0, total: 0, apps: [], cancelled: false })
    const entries: AppEntry[] = []
    const apps: InstalledApp[] = []
    const ids = new Set<string>()
    for (const entry of await this.discover()) {
      const app = listed(entry)
      // The same program can be registered twice, as in both registry views on Windows.
      if (ids.has(app.id)) continue
      ids.add(app.id)
      entries.push(entry)
      apps.push(app)
    }
    this.icons = new Map(entries.flatMap((entry, i) => (entry.icon ? [[apps[i].id, entry.icon] as const] : [])))

    const snapshot = () => markNested(apps).sort(bySize)
    const remember = (list: InstalledApp[]) => {
      this.locations = new Map(list.flatMap((app) => (app.location ? [[app.id, app.location] as const] : [])))
    }
    const pending = apps.flatMap((app, i) => (app.sizeKind === 'pending' ? [i] : []))
    let measured = 0
    let sentAt = 0
    const send = (force: boolean) => {
      const now = Date.now()
      if (!force && now - sentAt < PROGRESS_MS) return
      sentAt = now
      const list = snapshot()
      remember(list)
      this.onProgress?.({ phase: 'measuring', measured, total: pending.length, apps: list, cancelled: false })
    }
    send(true)

    // Apps registered with the same folder share one walk.
    const folders = new Map<string, Promise<Usage | null>>()
    await forEachConcurrent(pending, MEASURE_CONCURRENCY, async (i) => {
      if (this.cancelled) return
      apps[i] = await this.measure(entries[i], apps[i], folders)
      if (apps[i].sizeKind !== 'pending') measured++
      send(false)
    })

    const cancelled = this.cancelled
    for (const i of pending) {
      if (apps[i].sizeKind === 'pending') apps[i] = { ...apps[i], ...unmeasured(entries[i]) }
    }
    const list = snapshot()
    remember(list)
    this.result = { apps: list, cancelled }
    this.onProgress?.({ phase: 'done', measured, total: pending.length, ...this.result })
    return this.result
  }

  private async measure(
    entry: AppEntry,
    app: InstalledApp,
    folders: Map<string, Promise<Usage | null>>
  ): Promise<InstalledApp> {
    const footprint = entry.footprint!
    const stopped = () => this.cancelled
    let usage: Usage | null
    try {
      if (footprint.kind === 'folder') {
        const key = folderKey(footprint.path)
        let walk = folders.get(key)
        if (!walk) {
          walk = measureFolder(footprint.path, stopped)
          folders.set(key, walk)
        }
        usage = await walk
      } else {
        usage = await measureFiles(footprint.paths, stopped)
      }
    } catch {
      // The registered folder is gone or is not a folder: only the installer's figure is left.
      const location = app.locationIsFolder ? null : app.location
      return { ...app, ...unmeasured(entry), location, locationIsFolder: false }
    }
    if (!usage) return app
    // None of a package's files could be read, which says nothing about its size.
    if (footprint.kind === 'files' && usage.files === 0 && usage.partial) return { ...app, ...unmeasured(entry) }
    return { ...app, size: usage.bytes, allocated: usage.allocated, sizeKind: 'measured', partial: usage.partial }
  }
}
