import { useMemo, useRef, useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import { formatBytes } from '@shared/format'
import { arcPath, layoutSunburst } from '@shared/sunburst-layout'
import type { SunburstArc } from '@shared/sunburst-layout'
import type { NodeSummary } from '@shared/types'
import { ChartToolbar, ChartTooltip, TypeLegend, useGoUp } from '@/components/charts/chart-parts'
import {
  EMPTY_NODE,
  fitText,
  toSummary,
  useChartData,
  useChartTheme,
  useColorMode,
  useElementSize
} from '@/components/charts/chart-utils'
import { ItemMenu } from '@/components/item-menu'
import { cn } from '@/lib/utils'
import { useScan } from '@/scan-context'

const COLOR_MODE_KEY = 'sunburst.colorMode'
/** Space kept clear around the chart. */
const MARGIN = 12
const LABEL_FONT = '500 11px'
/** A label needs at least this much room across the slice, at the middle of its ring. */
const LABEL_MIN_ARC = 13
const LABEL_MIN_RING = 28

function canZoom(arc: SunburstArc): boolean {
  return arc.node.kind === 'dir' && !arc.special
}

/** Labels run outward along the ring, flipped on the left half so they never read upside down. */
function ArcLabel({ arc }: { arc: SunburstArc }) {
  const mid = (arc.a0 + arc.a1) / 2
  const midR = (arc.r0 + arc.r1) / 2
  if ((arc.a1 - arc.a0) * midR < LABEL_MIN_ARC || arc.r1 - arc.r0 < LABEL_MIN_RING) return null
  const name = fitText(arc.node.name, arc.r1 - arc.r0 - 8, LABEL_FONT)
  if (!name) return null
  const deg = (mid * 180) / Math.PI - 90
  const flip = mid > Math.PI ? 180 : 0
  return (
    <text
      transform={`rotate(${deg}) translate(${midR} 0) rotate(${flip})`}
      textAnchor="middle"
      dominantBaseline="central"
      fontSize={11}
      fontWeight={500}
      fill={arc.text}
      className="pointer-events-none"
    >
      {name}
    </text>
  )
}

export function SunburstView() {
  const { treemap: data, selectedPath, selectedNode, selectPath, meta } = useScan()
  const wrapRef = useRef<HTMLDivElement>(null)
  const size = useElementSize(wrapRef)
  const [colorMode, setColorMode] = useColorMode(COLOR_MODE_KEY)
  const [hover, setHover] = useState<{ path: string; x: number; y: number } | null>(null)
  const [menuItem, setMenuItem] = useState<NodeSummary | null>(null)
  const theme = useChartTheme()
  const chartData = useChartData()
  const { canGoUp, goUp, onKeyDown } = useGoUp()

  const radius = Math.max(0, Math.min(size.w, size.h) / 2 - MARGIN)
  const layout = useMemo(() => {
    if (!chartData || radius < 40) return null
    return layoutSunburst(chartData, radius, colorMode, theme)
  }, [chartData, radius, colorMode, theme])

  const arcs = layout?.arcs ?? []
  const total = layout?.total || 1
  const hole = layout?.hole ?? 0

  const byPath = useMemo(() => new Map(arcs.map((a) => [a.node.path, a])), [arcs])
  const hovered = hover ? byPath.get(hover.path) : undefined

  // The slices only change with the layout, so hovering never re-renders them.
  const slices = useMemo<ReactNode>(
    () =>
      arcs.map((arc, i) => (
        <g
          key={arc.node.path}
          data-i={i}
          className={cn('sunburst-arc', canZoom(arc) ? 'cursor-pointer' : 'cursor-default')}
        >
          <path d={arcPath(arc.a0, arc.a1, arc.r0, arc.r1)} fill={arc.fill} className="stroke-background" />
          <ArcLabel arc={arc} />
        </g>
      )),
    [arcs]
  )

  const arcFromEvent = (e: MouseEvent): SunburstArc | null => {
    const el = (e.target as Element).closest?.('[data-i]')
    return el ? (arcs[Number(el.getAttribute('data-i'))] ?? null) : null
  }

  const centerName = fitText(selectedNode?.name ?? chartData?.name ?? 'Folder', hole * 1.6, '600 13px')

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <ChartToolbar
        canGoUp={canGoUp}
        onUp={goUp}
        colorMode={colorMode}
        onColorMode={setColorMode}
        minLabel="Min slice"
        minAriaLabel="Minimum slice size"
      />
      <ItemMenu item={menuItem ?? toSummary(chartData ?? EMPTY_NODE, null)}>
        <div
          ref={wrapRef}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onContextMenu={(e) => {
            const arc = arcFromEvent(e)
            if (!arc || arc.special) {
              e.preventDefault()
              return
            }
            setMenuItem(toSummary(arc.node, arc.parentPath))
          }}
          className="relative min-h-0 flex-1 overflow-hidden bg-background outline-none"
        >
          {size.w < 16 || size.h < 16 || !data ? (
            <p className="animate-fade p-6 text-sm text-muted-foreground">Preparing sunburst…</p>
          ) : !layout ? (
            <p className="animate-fade p-6 text-sm text-muted-foreground">Make the window larger to see the chart.</p>
          ) : arcs.length === 0 ? (
            <p className="animate-fade p-6 text-sm text-muted-foreground">
              Nothing large enough to draw. Lower the min slice size or pick a bigger folder.
            </p>
          ) : (
            <svg
              key={selectedPath ?? 'root'}
              width={size.w}
              height={size.h}
              className="animate-fade block select-none"
              role="img"
              aria-label={`Sunburst chart of ${selectedNode?.name ?? 'folder'}`}
              onMouseMove={(e) => {
                const arc = arcFromEvent(e)
                const box = e.currentTarget.getBoundingClientRect()
                setHover(arc ? { path: arc.node.path, x: e.clientX - box.left, y: e.clientY - box.top } : null)
              }}
              onMouseLeave={() => setHover(null)}
              onClick={(e) => {
                // Ctrl+click is the context menu on macOS, not a zoom.
                if (e.ctrlKey && meta?.platform === 'darwin') return
                const arc = arcFromEvent(e)
                if (arc && canZoom(arc)) selectPath(arc.node.path)
              }}
            >
              <g transform={`translate(${size.w / 2} ${size.h / 2})`}>
                {slices}
                {hovered ? (
                  <path
                    d={arcPath(
                      hovered.a0,
                      hovered.a1,
                      hovered.r0 + 0.75,
                      Math.max(hovered.r0 + 0.75, hovered.r1 - 0.75)
                    )}
                    fill="none"
                    strokeWidth={1.5}
                    className="pointer-events-none stroke-foreground"
                  />
                ) : null}
                <g
                  className={cn(canGoUp ? 'cursor-pointer' : 'cursor-default')}
                  onClick={(e) => {
                    e.stopPropagation()
                    goUp()
                  }}
                >
                  <title>{canGoUp ? 'Up one level' : (selectedNode?.name ?? '')}</title>
                  <circle r={Math.max(0, hole - 1)} className="fill-card stroke-border" />
                  <text y={-4} textAnchor="middle" className="fill-foreground text-[13px] font-semibold">
                    {centerName}
                  </text>
                  <text y={14} textAnchor="middle" className="fill-muted-foreground text-[11px] tabular">
                    {formatBytes(selectedNode?.size ?? chartData?.value ?? 0)}
                  </text>
                </g>
              </g>
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
