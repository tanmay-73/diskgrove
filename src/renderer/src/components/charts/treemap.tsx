import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react'
import { ArrowUp } from 'lucide-react'
import { formatBytes, formatPercent } from '@shared/format'
import { FREE_SPACE_PATH, HEADER_HEIGHT, layoutTreemap } from '@shared/treemap-layout'
import type { TreemapCell, TreemapColorMode, TreemapTheme } from '@shared/treemap-layout'
import type { NodeSummary, TreemapNode } from '@shared/types'
import { ItemMenu } from '@/components/item-menu'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { cssVar, mutedFill, themePalette } from '@/lib/palette'
import { cn } from '@/lib/utils'
import { useScan } from '@/scan-context'

const COLOR_MODE_KEY = 'treemap.colorMode'
const PAD = 5
const TOOLTIP_WIDTH = 280

function loadColorMode(): TreemapColorMode {
  try {
    return localStorage.getItem(COLOR_MODE_KEY) === 'type' ? 'type' : 'folder'
  } catch {
    return 'folder'
  }
}

function saveColorMode(mode: TreemapColorMode): void {
  try {
    localStorage.setItem(COLOR_MODE_KEY, mode)
  } catch {
    // Preference just won't persist.
  }
}

function readTheme(): TreemapTheme {
  return {
    palette: themePalette(),
    background: cssVar('--background', '#0c1017'),
    foreground: cssVar('--foreground', '#e8eef6'),
    muted: mutedFill()
  }
}

/** Bumps whenever the app theme flips so colors are re-read from CSS. */
function useThemeVersion(): number {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const observer = new MutationObserver(() => setVersion((v) => v + 1))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] })
    return () => observer.disconnect()
  }, [])
  return version
}

let measureCtx: CanvasRenderingContext2D | null = null
let fontFamily = ''

function textWidth(text: string, font: string): number {
  if (!measureCtx) {
    measureCtx = document.createElement('canvas').getContext('2d')
    fontFamily = getComputedStyle(document.body).fontFamily || 'sans-serif'
  }
  if (!measureCtx) return text.length * 7
  measureCtx.font = `${font} ${fontFamily}`
  return measureCtx.measureText(text).width
}

/** Longest prefix of `text` (with an ellipsis) that fits in `max` pixels. */
function fitText(text: string, max: number, font: string): string {
  if (max <= 0) return ''
  if (textWidth(text, font) <= max) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (textWidth(`${text.slice(0, mid)}…`, font) <= max) lo = mid
    else hi = mid - 1
  }
  return lo >= 2 ? `${text.slice(0, lo).trimEnd()}…` : ''
}

function toSummary(node: TreemapNode, parentPath: string | null): NodeSummary {
  return {
    path: node.path,
    name: node.name,
    kind: node.kind,
    size: node.value,
    allocated: node.value,
    mtime: 0,
    atime: 0,
    ctime: 0,
    fileCount: 0,
    folderCount: 0,
    ext: node.ext,
    parentPath,
    hasSubdirs: Boolean(node.children?.some((c) => c.kind === 'dir'))
  }
}

function canZoom(cell: TreemapCell): boolean {
  return cell.node.kind === 'dir' && !cell.special
}

function CellLabel({ cell, total }: { cell: TreemapCell; total: number }) {
  const w = cell.x1 - cell.x0
  const h = cell.y1 - cell.y0
  const x = cell.x0 + PAD
  const room = w - PAD * 2
  const size = formatBytes(cell.node.value)

  if (cell.isFrame) {
    if (!cell.hasHeader) return null
    const sizeWidth = textWidth(size, '11px')
    const showSize = room - sizeWidth - 12 >= Math.min(60, textWidth(cell.node.name, '600 11px'))
    const name = fitText(cell.node.name, showSize ? room - sizeWidth - 12 : room, '600 11px')
    if (!name) return null
    const baseline = cell.y0 + HEADER_HEIGHT / 2 + 4
    return (
      <g fill={cell.text} fontSize={11} className="pointer-events-none">
        <text x={x} y={baseline} fontWeight={600}>
          {name}
        </text>
        {showSize ? (
          <text x={cell.x1 - PAD} y={baseline} textAnchor="end" fillOpacity={0.75}>
            {size}
          </text>
        ) : null}
      </g>
    )
  }

  if (w < 28 || h < 16) return null
  const big = w >= 160 && h >= 72
  const nameFont = big ? '600 13px' : '500 11px'
  const name = fitText(cell.node.name, room, nameFont)
  if (!name) return null
  const lineHeight = big ? 17 : 14
  const pct = total > 0 ? formatPercent((cell.node.value / total) * 100) : ''
  const details =
    h >= lineHeight * 2 + 6 ? fitText(`${size} · ${pct}`, room, '11px') || fitText(size, room, '11px') : ''
  return (
    <g fill={cell.text} className="pointer-events-none">
      <text x={x} y={cell.y0 + (big ? 18 : 14)} fontSize={big ? 13 : 11} fontWeight={big ? 600 : 500}>
        {name}
      </text>
      {details ? (
        <text x={x} y={cell.y0 + (big ? 18 : 14) + lineHeight} fontSize={11} fillOpacity={0.8}>
          {details}
        </text>
      ) : null}
    </g>
  )
}

export function TreemapView() {
  const {
    treemap: data,
    rootPath,
    selectedPath,
    selectedNode,
    complete,
    settings,
    treemapDepth,
    treemapMin,
    setTreemapDepth,
    setTreemapMin,
    selectPath,
    meta
  } = useScan()
  const wrapRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [colorMode, setColorMode] = useState<TreemapColorMode>(loadColorMode)
  const [hover, setHover] = useState<{ path: string; x: number; y: number } | null>(null)
  const [menuItem, setMenuItem] = useState<NodeSummary | null>(null)
  const themeVersion = useThemeVersion()
  // Re-read CSS colors whenever the theme flips.
  const theme = useMemo(readTheme, [themeVersion])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const measure = () => {
      const w = el.clientWidth
      const h = el.clientHeight
      if (w >= 16 && h >= 16) setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }))
    }
    measure()
    const frame = requestAnimationFrame(measure)
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
    }
  }, [])

  const chartData = useMemo(() => {
    if (!data) return null
    const atRoot = Boolean(complete && selectedPath && selectedPath === complete.rootPath)
    if (settings.showFreeSpace && atRoot && complete?.isVolumeRoot && complete.freeSpace > 0) {
      return {
        ...data,
        children: [
          ...(data.children ?? []),
          {
            path: FREE_SPACE_PATH,
            name: 'Free space',
            kind: 'file' as const,
            value: complete.freeSpace,
            ext: ''
          }
        ]
      }
    }
    return data
  }, [data, settings.showFreeSpace, complete, selectedPath])

  const layout = useMemo(() => {
    if (!chartData || size.w < 16 || size.h < 16) return null
    return layoutTreemap(chartData, size.w, size.h, colorMode, theme)
  }, [chartData, size, colorMode, theme])

  const cells = layout?.cells ?? []
  const total = layout?.total || 1

  const byPath = useMemo(() => new Map(cells.map((c) => [c.node.path, c])), [cells])
  const hovered = hover ? byPath.get(hover.path) : undefined

  // The tiles only change with the layout, so hovering never re-renders them.
  const tiles = useMemo<ReactNode>(
    () =>
      cells.map((cell, i) => (
        <g
          key={cell.node.path}
          data-i={i}
          className={cn('treemap-cell', canZoom(cell) ? 'cursor-pointer' : 'cursor-default')}
        >
          <rect
            x={cell.x0}
            y={cell.y0}
            width={cell.x1 - cell.x0}
            height={cell.y1 - cell.y0}
            fill={cell.fill}
            rx={cell.isFrame ? 3 : 2}
          />
          <CellLabel cell={cell} total={total} />
        </g>
      )),
    [cells, total]
  )

  const cellFromEvent = (e: MouseEvent): TreemapCell | null => {
    const el = (e.target as Element).closest?.('[data-i]')
    return el ? (cells[Number(el.getAttribute('data-i'))] ?? null) : null
  }

  const parentPath = selectedNode?.parentPath ?? null
  const canGoUp = Boolean(parentPath && selectedPath && selectedPath !== rootPath)
  const goUp = () => {
    if (canGoUp && parentPath) selectPath(parentPath)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    // Alt+Up is Explorer's "up a level", Cmd+Up is Finder's.
    if (e.key === 'Backspace' || ((e.altKey || e.metaKey) && e.key === 'ArrowUp')) {
      e.preventDefault()
      goUp()
    }
  }

  const changeColorMode = (mode: TreemapColorMode) => {
    setColorMode(mode)
    saveColorMode(mode)
  }

  const tooltipLeft = hover ? (hover.x + 16 + TOOLTIP_WIDTH > size.w ? hover.x - 16 - TOOLTIP_WIDTH : hover.x + 16) : 0
  const tooltipTop = hover ? Math.min(hover.y + 16, Math.max(0, size.h - 110)) : 0

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b px-3 py-2 text-xs">
        <Button
          variant="outline"
          size="sm"
          disabled={!canGoUp}
          onClick={goUp}
          title="Up one level (Backspace)"
          aria-label="Up one level"
        >
          <ArrowUp /> Up
        </Button>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">Depth</span>
          <Slider
            value={[treemapDepth]}
            min={1}
            max={6}
            step={1}
            className="w-28"
            aria-label="Level of detail"
            onValueChange={(v) => setTreemapDepth(v[0] ?? 3)}
          />
          <span className="w-3 tabular">{treemapDepth}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">Min tile</span>
          <Slider
            value={[treemapMin]}
            min={0.05}
            max={3}
            step={0.05}
            className="w-28"
            aria-label="Minimum tile size"
            onValueChange={(v) => setTreemapMin(v[0] ?? 0.4)}
          />
          <span className="w-10 tabular">{treemapMin.toFixed(2)}%</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">Color by</span>
          <div className="flex rounded-md border p-0.5" role="group" aria-label="Color by">
            {(
              [
                ['folder', 'Folder'],
                ['type', 'File type']
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                aria-pressed={colorMode === mode}
                className={cn(
                  'rounded px-2 py-0.5 transition-colors duration-150',
                  colorMode === mode
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
                onClick={() => changeColorMode(mode)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <span className="ml-auto min-w-0 truncate text-muted-foreground">
          {selectedNode ? `${selectedNode.name} · ${formatBytes(selectedNode.size)}` : null}
        </span>
      </div>
      <ItemMenu item={menuItem ?? toSummary(chartData ?? EMPTY_NODE, null)}>
        <div
          ref={wrapRef}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onContextMenu={(e) => {
            const cell = cellFromEvent(e)
            if (!cell || cell.special) {
              e.preventDefault()
              return
            }
            setMenuItem(toSummary(cell.node, cell.parentPath))
          }}
          className="relative min-h-0 flex-1 overflow-hidden bg-background outline-none"
        >
          {size.w < 16 || size.h < 16 || !data ? (
            <p className="animate-fade p-6 text-sm text-muted-foreground">Preparing treemap…</p>
          ) : cells.length === 0 ? (
            <p className="animate-fade p-6 text-sm text-muted-foreground">
              Nothing large enough to draw. Lower the min tile size or pick a bigger folder.
            </p>
          ) : (
            <svg
              key={selectedPath ?? 'root'}
              width={size.w}
              height={size.h}
              className="animate-fade block select-none"
              role="img"
              aria-label={`Treemap of ${selectedNode?.name ?? 'folder'}`}
              onMouseMove={(e) => {
                const cell = cellFromEvent(e)
                const box = e.currentTarget.getBoundingClientRect()
                setHover(cell ? { path: cell.node.path, x: e.clientX - box.left, y: e.clientY - box.top } : null)
              }}
              onMouseLeave={() => setHover(null)}
              onClick={(e) => {
                // Ctrl+click is the context menu on macOS, not a zoom.
                if (e.ctrlKey && meta?.platform === 'darwin') return
                const cell = cellFromEvent(e)
                if (cell && canZoom(cell)) selectPath(cell.node.path)
              }}
            >
              {tiles}
              {hovered ? (
                <rect
                  x={hovered.x0 + 0.5}
                  y={hovered.y0 + 0.5}
                  width={Math.max(0, hovered.x1 - hovered.x0 - 1)}
                  height={Math.max(0, hovered.y1 - hovered.y0 - 1)}
                  rx={2}
                  fill="none"
                  strokeWidth={1.5}
                  className="pointer-events-none stroke-foreground"
                />
              ) : null}
            </svg>
          )}
          {hover && hovered ? (
            <div
              className="pointer-events-none absolute z-10 rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md"
              style={{ left: Math.max(4, tooltipLeft), top: tooltipTop, width: TOOLTIP_WIDTH }}
            >
              <div className="flex items-center gap-2">
                <span className="size-2.5 shrink-0 rounded-sm" style={{ background: hovered.fill }} />
                <span className="min-w-0 flex-1 truncate font-semibold">{hovered.node.name}</span>
              </div>
              <div className="mt-1 tabular">
                {formatBytes(hovered.node.value)} · {formatPercent((hovered.node.value / total) * 100)}
              </div>
              {hovered.special ? null : (
                <div className="mt-1 line-clamp-2 break-all text-muted-foreground">{hovered.node.path}</div>
              )}
              <div className="mt-1 text-muted-foreground">
                {hovered.subtext}
                {canZoom(hovered) ? ' · click to zoom in' : ''}
              </div>
            </div>
          ) : null}
        </div>
      </ItemMenu>
      {colorMode === 'type' && layout?.legend.length ? (
        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t px-3 py-1.5 text-xs">
          {layout.legend.map((entry) => (
            <span key={entry.label} className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm" style={{ background: entry.color }} />
              <span>{entry.label}</span>
              <span className="tabular text-muted-foreground">{formatBytes(entry.value)}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

const EMPTY_NODE: TreemapNode = { path: '', name: '', kind: 'dir', value: 0, ext: '' }
