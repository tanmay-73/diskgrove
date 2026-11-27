import { useMemo, useRef, useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import { formatBytes, formatPercent } from '@shared/format'
import { HEADER_HEIGHT, layoutTreemap } from '@shared/treemap-layout'
import type { TreemapCell } from '@shared/treemap-layout'
import type { NodeSummary } from '@shared/types'
import { ChartToolbar, ChartTooltip, TypeLegend, useGoUp } from '@/components/charts/chart-parts'
import {
  EMPTY_NODE,
  fitText,
  textWidth,
  toSummary,
  useChartData,
  useChartTheme,
  useColorMode,
  useElementSize
} from '@/components/charts/chart-utils'
import { ItemMenu } from '@/components/item-menu'
import { cn } from '@/lib/utils'
import { useScan } from '@/scan-context'

const COLOR_MODE_KEY = 'treemap.colorMode'
const PAD = 5

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
  const { treemap: data, selectedPath, selectedNode, selectPath, meta } = useScan()
  const wrapRef = useRef<HTMLDivElement>(null)
  const size = useElementSize(wrapRef)
  const [colorMode, setColorMode] = useColorMode(COLOR_MODE_KEY)
  const [hover, setHover] = useState<{ path: string; x: number; y: number } | null>(null)
  const [menuItem, setMenuItem] = useState<NodeSummary | null>(null)
  const theme = useChartTheme()
  const chartData = useChartData()
  const { canGoUp, goUp, onKeyDown } = useGoUp()

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

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <ChartToolbar
        canGoUp={canGoUp}
        onUp={goUp}
        colorMode={colorMode}
        onColorMode={setColorMode}
        minLabel="Min tile"
        minAriaLabel="Minimum tile size"
      />
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
            <ChartTooltip
              x={hover.x}
              y={hover.y}
              bounds={size}
              fill={hovered.fill}
              name={hovered.node.name}
              value={hovered.node.value}
              total={total}
              path={hovered.special ? null : hovered.node.path}
              subtext={hovered.subtext}
              zoomable={canZoom(hovered)}
            />
          ) : null}
        </div>
      </ItemMenu>
      {colorMode === 'type' && layout ? <TypeLegend entries={layout.legend} /> : null}
    </div>
  )
}
