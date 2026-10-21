import { useMemo } from 'react'
import { formatBytes, formatPercent } from '@shared/format'
import { ScrollArea } from '@/components/ui/scroll-area'
import { colorAt, mutedFill } from '@/lib/palette'
import { useScan } from '@/scan-context'

interface Slice {
  name: string
  path: string
  value: number
  kind: 'file' | 'dir' | 'free'
}

export function PieView() {
  const { childrenOf, selectedPath, selectedNode, complete, settings, selectPath } = useScan()
  const slices = useMemo(() => {
    const kids = selectedPath ? childrenOf[selectedPath] : undefined
    const items: Slice[] = [...(kids?.dirs ?? []), ...(kids?.files ?? [])]
      .sort((a, b) => b.size - a.size)
      .map((n) => ({ name: n.name, path: n.path, value: n.size, kind: n.kind }))
    const top = items.slice(0, 10)
    const rest = items.slice(10).reduce((s, n) => s + n.value, 0)
    if (rest > 0) top.push({ name: 'Other', path: '', value: rest, kind: 'file' })
    if (
      settings.showFreeSpace &&
      complete?.isVolumeRoot &&
      selectedPath === complete.rootPath &&
      complete.freeSpace > 0
    ) {
      top.push({ name: 'Free space', path: '', value: complete.freeSpace, kind: 'free' })
    }
    return top.filter((s) => s.value > 0)
  }, [childrenOf, selectedPath, complete, settings.showFreeSpace])

  const total = slices.reduce((s, x) => s + x.value, 0) || 1
  let angle = -Math.PI / 2
  const cx = 180
  const cy = 180
  const r = 130
  const arcs = slices.map((slice, i) => {
    const delta = (slice.value / total) * Math.PI * 2
    const start = angle
    const end = angle + delta
    angle = end
    const large = delta > Math.PI ? 1 : 0
    const x1 = cx + r * Math.cos(start)
    const y1 = cy + r * Math.sin(start)
    const x2 = cx + r * Math.cos(end)
    const y2 = cy + r * Math.sin(end)
    const d = `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`
    return { ...slice, d, color: slice.kind === 'free' ? mutedFill() : colorAt(i) }
  })

  return (
    <ScrollArea className="h-full">
      <div className="flex">
        <svg
          key={selectedPath ?? 'root'}
          viewBox="0 0 360 360"
          className="animate-pie h-[380px] w-[380px] shrink-0 p-4"
        >
          {arcs.map((a) => (
            <path
              key={a.name + a.path}
              d={a.d}
              fill={a.color}
              className="cursor-pointer stroke-background stroke-2 transition-opacity duration-150 hover:opacity-80"
              onDoubleClick={() => a.kind === 'dir' && a.path && selectPath(a.path)}
            >
              <title>
                {a.name} — {formatBytes(a.value)} ({formatPercent((a.value / total) * 100)})
              </title>
            </path>
          ))}
          <circle cx={cx} cy={cy} r={58} className="fill-background" />
          <text x={cx} y={cy - 6} textAnchor="middle" className="fill-foreground text-[13px] font-semibold">
            {selectedNode?.name ?? 'Folder'}
          </text>
          <text x={cx} y={cy + 14} textAnchor="middle" className="fill-muted-foreground text-[11px]">
            {formatBytes(selectedNode?.size ?? 0)}
          </text>
        </svg>
        <div className="min-w-0 flex-1 p-4">
          {arcs.map((a, i) => (
            <button
              key={a.name + a.path}
              className="animate-rise flex w-full items-center gap-2 rounded px-1 py-1 text-left text-sm transition-colors duration-150 hover:bg-accent/50"
              style={{ animationDelay: `${i * 35}ms` }}
              onClick={() => a.kind === 'dir' && a.path && selectPath(a.path)}
            >
              <span className="size-2.5 rounded-sm" style={{ background: a.color }} />
              <span className="min-w-0 flex-1 truncate">{a.name}</span>
              <span className="tabular text-muted-foreground">{formatBytes(a.value)}</span>
              <span className="w-16 tabular text-right">{formatPercent((a.value / total) * 100)}</span>
            </button>
          ))}
        </div>
      </div>
    </ScrollArea>
  )
}
