import type { KeyboardEvent } from 'react'
import { ArrowUp } from 'lucide-react'
import { formatBytes, formatPercent } from '@shared/format'
import type { TreemapColorMode, TreemapLegendEntry } from '@shared/treemap-layout'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { cn } from '@/lib/utils'
import { useScan } from '@/scan-context'

const TOOLTIP_WIDTH = 280

/** Going up a level from the selected folder, shared by the chart views. */
export function useGoUp(): { canGoUp: boolean; goUp: () => void; onKeyDown: (e: KeyboardEvent) => void } {
  const { rootPath, selectedPath, selectedNode, selectPath } = useScan()
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
  return { canGoUp, goUp, onKeyDown }
}

export function ChartToolbar({
  canGoUp,
  onUp,
  colorMode,
  onColorMode,
  minLabel,
  minAriaLabel
}: {
  canGoUp: boolean
  onUp: () => void
  colorMode: TreemapColorMode
  onColorMode: (mode: TreemapColorMode) => void
  minLabel: string
  minAriaLabel: string
}) {
  const { selectedNode, treemapDepth, treemapMin, setTreemapDepth, setTreemapMin } = useScan()
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b px-3 py-2 text-xs">
      <Button
        variant="outline"
        size="sm"
        disabled={!canGoUp}
        onClick={onUp}
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
        <span className="text-muted-foreground">{minLabel}</span>
        <Slider
          value={[treemapMin]}
          min={0.05}
          max={3}
          step={0.05}
          className="w-28"
          aria-label={minAriaLabel}
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
                colorMode === mode ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'
              )}
              onClick={() => onColorMode(mode)}
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
  )
}

export function ChartTooltip({
  x,
  y,
  bounds,
  fill,
  name,
  value,
  total,
  path,
  subtext,
  zoomable
}: {
  x: number
  y: number
  bounds: { w: number; h: number }
  fill: string
  name: string
  value: number
  total: number
  /** Omitted for synthetic items like free space. */
  path: string | null
  subtext: string
  zoomable: boolean
}) {
  const left = x + 16 + TOOLTIP_WIDTH > bounds.w ? x - 16 - TOOLTIP_WIDTH : x + 16
  const top = Math.min(y + 16, Math.max(0, bounds.h - 110))
  return (
    <div
      className="pointer-events-none absolute z-10 rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md"
      style={{ left: Math.max(4, left), top, width: TOOLTIP_WIDTH }}
    >
      <div className="flex items-center gap-2">
        <span className="size-2.5 shrink-0 rounded-sm" style={{ background: fill }} />
        <span className="min-w-0 flex-1 truncate font-semibold">{name}</span>
      </div>
      <div className="mt-1 tabular">
        {formatBytes(value)} · {formatPercent((value / total) * 100)}
      </div>
      {path === null ? null : <div className="mt-1 line-clamp-2 break-all text-muted-foreground">{path}</div>}
      <div className="mt-1 text-muted-foreground">
        {subtext}
        {zoomable ? ' · click to zoom in' : ''}
      </div>
    </div>
  )
}

export function TypeLegend({ entries }: { entries: TreemapLegendEntry[] }) {
  if (!entries.length) return null
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t px-3 py-1.5 text-xs">
      {entries.map((entry) => (
        <span key={entry.label} className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm" style={{ background: entry.color }} />
          <span>{entry.label}</span>
          <span className="tabular text-muted-foreground">{formatBytes(entry.value)}</span>
        </span>
      ))}
    </div>
  )
}
