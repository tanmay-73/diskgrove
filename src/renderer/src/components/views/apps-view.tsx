import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  AppWindow,
  ArrowDown,
  ArrowUp,
  Copy,
  CornerDownRight,
  FolderOpen,
  Loader2,
  RefreshCw,
  ScanSearch,
  Search,
  Square,
  TriangleAlert,
  X
} from 'lucide-react'
import { formatBytes, formatCount, formatDay, formatNumber, formatPercent } from '@shared/format'
import type { AppSource, InstalledApp } from '@shared/types'
import { SizeBar } from '@/components/size-bar'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useAppIcon } from '@/hooks/use-app-icon'
import { useInstalledApps } from '@/hooks/use-installed-apps'
import { revealLabel } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { useScan } from '@/scan-context'

const SOURCE_LABEL: Record<AppSource, string> = {
  desktop: 'Desktop',
  store: 'Store',
  app: 'App',
  appstore: 'App Store',
  deb: 'deb',
  rpm: 'RPM',
  pacman: 'pacman',
  flatpak: 'Flatpak',
  snap: 'Snap',
  appimage: 'AppImage',
  folder: 'Folder',
  scoop: 'Scoop',
  homebrew: 'Homebrew',
  steam: 'Steam',
  epic: 'Epic',
  gog: 'GOG'
}

const SOURCE_TITLE: Record<AppSource, string> = {
  desktop: 'Desktop program installed with its own installer',
  store: 'Microsoft Store app',
  app: 'App bundle',
  appstore: 'From the Mac App Store',
  deb: 'Debian package',
  rpm: 'RPM package',
  pacman: 'Arch Linux package',
  flatpak: 'Flatpak app',
  snap: 'Snap package',
  appimage: 'AppImage',
  folder: 'Program in its own folder',
  scoop: 'Installed with Scoop',
  homebrew: 'Homebrew formula you installed, with every version kept',
  steam: 'Game installed by Steam',
  epic: 'Game installed by the Epic Games Launcher',
  gog: 'Game installed by GOG Galaxy or Heroic'
}

// Package managers spread an app's files over the system, so these have no one folder.
const PACKAGES: ReadonlySet<AppSource> = new Set<AppSource>(['deb', 'rpm', 'pacman'])

// What the sizes cover differs by system; each note says what is left out.
const PLATFORM_NOTE: Record<string, string> = {
  win32: 'Sizes add up each app’s install folder. Settings, caches and files an app keeps elsewhere are not included.',
  darwin:
    'Sizes add up each app bundle, game folder and Homebrew formula, not the formulae it depends on. Data an app keeps in your Library folder is not included.',
  linux:
    'Package sizes add up the files each package installed, not the libraries it shares with other apps. Flatpak sizes leave out shared runtimes. Data in your home folder outside an app’s own folder is not included.'
}

// Columns follow the pane's width (container queries). Narrow: Name · Size. @md adds %,
// @2xl adds Source and Installed, @4xl adds Location.
const GRID_COLS = cn(
  'grid-cols-[minmax(10rem,1fr)_7.5rem]',
  '@md:grid-cols-[minmax(10rem,1fr)_7.5rem_4.75rem]',
  '@2xl:grid-cols-[minmax(12rem,1fr)_6.5rem_7.5rem_4.75rem_8rem]',
  '@4xl:grid-cols-[minmax(12rem,1fr)_6.5rem_minmax(12rem,1.2fr)_7.5rem_4.75rem_8rem]'
)
const GRID_MIN_WIDTH = '19rem'

const CELL = 'flex min-w-0 items-center overflow-hidden whitespace-nowrap border-r border-border/60 px-2.5'
const LAST_CELL = 'flex min-w-0 items-center overflow-hidden whitespace-nowrap px-2.5'
const PCT_CELL = 'hidden @md:flex'
const WIDE_CELL = 'hidden @2xl:flex'
const LOCATION_CELL = 'hidden @4xl:flex'

type SortKey = 'name' | 'size' | 'installed'

interface Sort {
  key: SortKey
  dir: 'asc' | 'desc'
}

function compareApps(a: InstalledApp, b: InstalledApp, sort: Sort): number {
  const dir = sort.dir === 'asc' ? 1 : -1
  let order = 0
  if (sort.key === 'name') order = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) * dir
  else if (sort.key === 'installed') order = (a.installedAt - b.installedAt) * dir
  // Sizes not known yet stay at the end either way.
  else if (a.size === null || b.size === null) order = a.size === b.size ? 0 : a.size === null ? 1 : -1
  else order = (a.size - b.size) * dir
  return order || a.name.localeCompare(b.name)
}

function fold(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase()
}

function matches(app: InstalledApp, query: string): boolean {
  return [app.name, app.publisher, app.location ?? '', SOURCE_LABEL[app.source]].some((field) =>
    fold(field).includes(query)
  )
}

function subtitle(app: InstalledApp): string {
  return [app.publisher, app.version].filter(Boolean).join(' · ')
}

export function AppsView() {
  const { meta, startScan, showToast } = useScan()
  const { apps, progress, busy, stopping, cancelled, error, refresh, stop } = useInstalledApps()
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<Sort>({ key: 'size', dir: 'desc' })
  const [activeId, setActiveId] = useState<string | null>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)

  const term = fold(query.trim())
  const rows = useMemo(
    () => (term ? apps.filter((app) => matches(app, term)) : [...apps]).sort((a, b) => compareApps(a, b, sort)),
    [apps, term, sort]
  )
  // Apps inside another listed app's folder are already in that app's size.
  const counted = apps.filter((app) => app.size !== null && !app.insideOf)
  const total = counted.reduce((sum, app) => sum + (app.size ?? 0), 0)
  const estimated = apps.filter((app) => app.sizeKind === 'estimated').length
  const maxSize = rows.reduce((max, app) => Math.max(max, app.size ?? 0), 0) || 1
  const measuring = busy && progress?.phase === 'measuring'
  const listing = busy && (!progress || progress.phase === 'listing')

  const reveal = useCallback(
    async (app: InstalledApp) => {
      if (!app.location) return
      try {
        await window.diskgrove.revealApp(app.id)
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Could not show the app')
      }
    },
    [showToast]
  )

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      const command = meta?.platform === 'darwin' ? event.metaKey : event.ctrlKey
      if (command && !event.altKey && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        filterRef.current?.focus()
        filterRef.current?.select()
      } else if (event.key === 'F5' && !busy) {
        event.preventDefault()
        refresh()
      } else if (event.key === 'Escape' && measuring && !stopping) {
        stop()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [meta, busy, measuring, stopping, refresh, stop])

  const focusRow = (id: string) => {
    setActiveId(id)
    gridRef.current?.querySelector<HTMLElement>(`[data-app-id="${id}"]`)?.focus()
  }

  const onRowKeyDown = (event: KeyboardEvent, index: number) => {
    const to = (next: number) => {
      const app = rows[Math.max(0, Math.min(rows.length - 1, next))]
      if (app) focusRow(app.id)
    }
    if (event.key === 'ArrowDown') to(index + 1)
    else if (event.key === 'ArrowUp') to(index - 1)
    else if (event.key === 'Home') to(0)
    else if (event.key === 'End') to(rows.length - 1)
    else if (event.key === 'Enter') void reveal(rows[index])
    else return
    event.preventDefault()
  }

  // One row takes Tab focus: the active one if it is listed, else the first.
  const tabStop = rows.some((app) => app.id === activeId) ? activeId : (rows[0]?.id ?? null)

  let summary: string
  if (listing && apps.length === 0) summary = 'Finding installed apps…'
  else if (term) summary = `${formatNumber(rows.length)} of ${formatCount(apps.length, 'app')}`
  else summary = `${formatCount(apps.length, 'app')} · ${formatBytes(total)}`
  if (!term && estimated > 0 && !listing) summary += ` · ${formatNumber(estimated)} estimated`

  return (
    <div className="animate-pane flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-sm font-semibold">
            <AppWindow className="size-4 text-muted-foreground" /> Installed apps
          </h1>
          <p className="tabular text-xs text-muted-foreground" aria-live="polite">
            {summary}
          </p>
        </div>
        <div className="ml-auto flex min-w-0 items-center gap-2">
          <div className="relative w-56 min-w-0">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={filterRef}
              value={query}
              placeholder="Filter apps"
              aria-label="Filter apps by name, publisher or location"
              className="h-7 pl-7 pr-7 text-xs"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && query) {
                  // Clears the filter without also stopping the measuring.
                  event.stopPropagation()
                  setQuery('')
                } else if (event.key === 'ArrowDown' && rows[0]) {
                  event.preventDefault()
                  focusRow(tabStop ?? rows[0].id)
                }
              }}
            />
            {query ? (
              <button
                type="button"
                aria-label="Clear filter"
                className="absolute right-1 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground"
                onClick={() => {
                  setQuery('')
                  filterRef.current?.focus()
                }}
              >
                <X className="size-3" />
              </button>
            ) : null}
          </div>
          {measuring ? (
            <Button size="sm" variant="outline" aria-label="Stop measuring" disabled={stopping} onClick={stop}>
              <Square />
              {stopping ? 'Stopping…' : 'Stop'}
            </Button>
          ) : null}
          <Button size="sm" variant="outline" disabled={busy} onClick={refresh}>
            <RefreshCw className={cn(busy && 'animate-spin')} /> Refresh
          </Button>
        </div>
      </div>

      <div className="flex h-6 shrink-0 items-center gap-3 border-b bg-muted/30 px-4 text-[11px] text-muted-foreground">
        {measuring && progress ? (
          <>
            <span className="tabular shrink-0">
              {stopping
                ? 'Stopping…'
                : `Measuring ${formatNumber(progress.measured)} of ${formatNumber(progress.total)}`}
            </span>
            <Progress
              value={progress.total ? (progress.measured / progress.total) * 100 : 0}
              className="h-1 max-w-xs flex-1"
              aria-label="Measuring app sizes"
            />
          </>
        ) : listing ? (
          <span className="flex items-center gap-1.5">
            <Loader2 className="size-3 animate-spin" /> Finding installed apps…
          </span>
        ) : cancelled ? (
          <span>Stopped · some sizes were not measured. Refresh to measure them.</span>
        ) : (
          <span className="truncate">
            {PLATFORM_NOTE[meta?.platform ?? ''] ?? PLATFORM_NOTE.linux} Apps inside another app’s folder count once in
            the total.
          </span>
        )}
      </div>

      <div className="@container min-h-0 min-w-0 flex-1">
        <ScrollArea
          className="h-full min-w-0"
          viewportRef={gridRef}
          viewportClassName="select-none"
          viewportProps={{ role: 'grid', 'aria-label': 'Installed apps', 'aria-rowcount': rows.length + 1 }}
        >
          <div
            role="row"
            className={cn(
              'sticky top-0 z-20 grid h-8 w-full items-stretch border-b bg-muted text-[11px] font-semibold uppercase tracking-wide text-muted-foreground',
              GRID_COLS
            )}
            style={{ minWidth: GRID_MIN_WIDTH }}
          >
            <SortHeader label="Name" column="name" sort={sort} onSort={setSort} className={CELL} />
            <span role="columnheader" className={cn(CELL, WIDE_CELL)}>
              Source
            </span>
            <span role="columnheader" className={cn(CELL, LOCATION_CELL)}>
              Location
            </span>
            <SortHeader
              label="Size"
              column="size"
              sort={sort}
              onSort={setSort}
              align="right"
              className={cn(CELL, '@max-md:border-r-0')}
            />
            <span
              role="columnheader"
              className={cn(CELL, PCT_CELL, 'justify-end @max-2xl:border-r-0')}
              title="Share of the total size of the listed apps"
            >
              %
            </span>
            <SortHeader
              label="Installed"
              title="Installed or last updated"
              column="installed"
              sort={sort}
              onSort={setSort}
              className={cn(LAST_CELL, WIDE_CELL)}
            />
          </div>

          {error ? (
            <div className="animate-fade flex flex-col items-start gap-3 p-6 text-sm">
              <p className="flex items-center gap-2 text-destructive">
                <TriangleAlert className="size-4 shrink-0" /> {error}
              </p>
              <Button size="sm" variant="outline" onClick={refresh}>
                <RefreshCw /> Try again
              </Button>
            </div>
          ) : listing && apps.length === 0 ? (
            <div className="space-y-px p-0" aria-hidden>
              {Array.from({ length: 8 }, (_, i) => (
                <div key={i} className="h-11 animate-pulse border-b border-border/40 bg-muted/30" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <p className="animate-fade p-6 text-sm text-muted-foreground">
              {term ? `No apps match “${query.trim()}”.` : 'No installed apps were found.'}
            </p>
          ) : (
            <div style={{ minWidth: GRID_MIN_WIDTH }}>
              {rows.map((app, i) => (
                <AppMenu
                  key={app.id}
                  app={app}
                  platform={meta?.platform}
                  onReveal={() => void reveal(app)}
                  onScan={() => app.location && void startScan(app.location)}
                >
                  <div
                    role="row"
                    data-app-id={app.id}
                    tabIndex={app.id === tabStop ? 0 : -1}
                    aria-selected={app.id === activeId}
                    title={app.location ?? app.name}
                    className={cn(
                      'grid min-h-11 w-full cursor-default items-stretch border-b border-border/40 text-[13px] outline-none transition-colors duration-150 hover:bg-accent/60 focus-visible:shadow-[inset_0_0_0_1px_var(--ring)]',
                      GRID_COLS,
                      i % 2 === 1 && 'bg-muted/30',
                      app.id === activeId && 'bg-primary/15 hover:bg-primary/20'
                    )}
                    onClick={() => setActiveId(app.id)}
                    onFocus={() => setActiveId(app.id)}
                    onDoubleClick={() => void reveal(app)}
                    onKeyDown={(event) => onRowKeyDown(event, i)}
                  >
                    <span role="gridcell" className={cn(CELL, 'gap-2.5 py-1')}>
                      <AppIcon app={app} />
                      <span className="flex min-w-0 flex-1 flex-col leading-tight">
                        <span className="truncate font-medium">{app.name}</span>
                        <span className="truncate text-[11px] text-muted-foreground">
                          {/* Below @2xl the source has no column of its own. */}
                          <span className="@2xl:hidden">{SOURCE_LABEL[app.source]}</span>
                          {subtitle(app) ? <span className="@2xl:hidden"> · </span> : null}
                          {subtitle(app)}
                        </span>
                        {app.insideOf ? (
                          <span
                            className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground"
                            title={`This app’s folder is inside ${app.insideOf}’s, so the total counts it once`}
                          >
                            <CornerDownRight className="size-3 shrink-0" />
                            <span className="truncate">Inside {app.insideOf}</span>
                          </span>
                        ) : null}
                      </span>
                    </span>
                    <span role="gridcell" className={cn(CELL, WIDE_CELL)}>
                      <span
                        className="truncate rounded bg-secondary px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground"
                        title={SOURCE_TITLE[app.source]}
                      >
                        {SOURCE_LABEL[app.source]}
                      </span>
                    </span>
                    <span role="gridcell" className={cn(CELL, LOCATION_CELL, 'text-muted-foreground')}>
                      {app.location ? (
                        <span className="truncate-start min-w-0 flex-1">
                          <bdi>{app.location}</bdi>
                        </span>
                      ) : (
                        <span className="truncate">{PACKAGES.has(app.source) ? 'Files of the package' : '—'}</span>
                      )}
                    </span>
                    <span role="gridcell" className={cn(CELL, 'relative justify-end tabular @max-md:border-r-0')}>
                      <SizeCell app={app} ratio={(app.size ?? 0) / maxSize} cancelled={cancelled} />
                    </span>
                    <span role="gridcell" className={cn(CELL, PCT_CELL, 'justify-end tabular @max-2xl:border-r-0')}>
                      {app.size === null || app.insideOf || !total ? '—' : formatPercent((app.size / total) * 100)}
                    </span>
                    <span role="gridcell" className={cn(LAST_CELL, WIDE_CELL, 'text-muted-foreground')}>
                      <span className="min-w-0 flex-1 truncate">{formatDay(app.installedAt)}</span>
                    </span>
                  </div>
                </AppMenu>
              ))}
            </div>
          )}
        </ScrollArea>
      </div>
    </div>
  )
}

/** The app's own icon, or a generic one while it loads and when the app has none. */
function AppIcon({ app }: { app: InstalledApp }) {
  const icon = useAppIcon(app.id, app.hasIcon)
  return (
    <span className="flex size-6 shrink-0 items-center justify-center" aria-hidden>
      {icon ? (
        <img src={icon} alt="" draggable={false} className="animate-fade size-6 object-contain" />
      ) : (
        <AppWindow className="size-4 text-muted-foreground" />
      )}
    </span>
  )
}

function SortHeader({
  label,
  title,
  column,
  sort,
  onSort,
  align,
  className
}: {
  label: string
  title?: string
  column: SortKey
  sort: Sort
  onSort: (sort: Sort) => void
  align?: 'right'
  className: string
}) {
  const active = sort.key === column
  return (
    <span
      role="columnheader"
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={cn(className, 'p-0')}
    >
      <button
        type="button"
        title={title ?? `Sort by ${label.toLowerCase()}`}
        className={cn(
          'flex h-full min-w-0 flex-1 items-center gap-1 bg-transparent px-2.5 uppercase tracking-wide text-inherit transition-colors duration-150 hover:text-foreground focus-visible:text-foreground focus-visible:outline-none',
          align === 'right' && 'justify-end',
          active && 'text-foreground'
        )}
        onClick={() =>
          // Names read best A to Z; sizes and dates largest and newest first.
          onSort({
            key: column,
            dir: active ? (sort.dir === 'asc' ? 'desc' : 'asc') : column === 'name' ? 'asc' : 'desc'
          })
        }
      >
        <span className="min-w-0 truncate">{label}</span>
        {active ? (
          sort.dir === 'desc' ? (
            <ArrowDown className="size-3 shrink-0 animate-icon-pop" />
          ) : (
            <ArrowUp className="size-3 shrink-0 animate-icon-pop" />
          )
        ) : null}
      </button>
    </span>
  )
}

function SizeCell({ app, ratio, cancelled }: { app: InstalledApp; ratio: number; cancelled: boolean }) {
  if (app.sizeKind === 'pending') {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" /> Measuring…
      </span>
    )
  }
  if (app.sizeKind === 'unknown' || app.size === null) {
    return (
      <span
        className="text-muted-foreground"
        title={cancelled ? 'Not measured: measuring was stopped' : 'DiskGrove could not find this app’s files'}
      >
        —
      </span>
    )
  }
  if (app.sizeKind === 'estimated') {
    return (
      <span
        className="text-muted-foreground"
        title="Reported by the app’s installer. DiskGrove could not find its folder to measure it."
      >
        ≈ {formatBytes(app.size)}
      </span>
    )
  }
  const onDisk = app.allocated === null ? '' : ` · ${formatBytes(app.allocated)} on disk`
  return (
    <>
      <SizeBar ratio={ratio} className="inset-y-[7px]" />
      <span className="relative z-10 flex items-center gap-1.5" title={`${formatBytes(app.size)}${onDisk}`}>
        {app.partial ? (
          <span
            role="img"
            aria-label="Some files could not be read, so the size may be low"
            title="Some files could not be read, so the size may be low"
            className="flex text-amber-400"
          >
            <TriangleAlert className="size-3.5" />
          </span>
        ) : null}
        {formatBytes(app.size)}
      </span>
    </>
  )
}

function AppMenu({
  app,
  platform,
  onReveal,
  onScan,
  children
}: {
  app: InstalledApp
  platform: string | undefined
  onReveal: () => void
  onScan: () => void
  children: ReactNode
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem disabled={!app.location} onClick={onReveal}>
          <FolderOpen className="size-4" /> {revealLabel(platform)}
        </ContextMenuItem>
        {app.locationIsFolder ? (
          <ContextMenuItem onClick={onScan}>
            <ScanSearch className="size-4" /> Scan this folder
          </ContextMenuItem>
        ) : null}
        <ContextMenuSeparator />
        {app.location ? (
          <ContextMenuItem onClick={() => void navigator.clipboard.writeText(app.location ?? '')}>
            <Copy className="size-4" /> Copy location
          </ContextMenuItem>
        ) : null}
        <ContextMenuItem onClick={() => void navigator.clipboard.writeText(app.name)}>
          <Copy className="size-4" /> Copy name
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
