import { useMemo } from 'react'
import { formatBytes, formatPercent } from '@shared/format'
import { GrowBar } from '@/components/size-bar'
import { ScrollArea } from '@/components/ui/scroll-area'
import { colorAt, mutedFill } from '@/lib/palette'
import { useScan } from '@/scan-context'

export function BarView() {
  const { childrenOf, selectedPath, complete, settings, selectPath } = useScan()
  const rows = useMemo(() => {
    const kids = selectedPath ? childrenOf[selectedPath] : undefined
    const items = [...(kids?.dirs ?? []), ...(kids?.files ?? [])].sort((a, b) => b.size - a.size).slice(0, 20)
    const max = items[0]?.size || 1
    const extra =
      settings.showFreeSpace && complete?.isVolumeRoot && selectedPath === complete.rootPath && complete.freeSpace > 0
        ? [{ name: 'Free space', path: '', size: complete.freeSpace, kind: 'free' as const }]
        : []
    return [...items.map((n) => ({ name: n.name, path: n.path, size: n.size, kind: n.kind })), ...extra].map(
      (n, i) => ({
        ...n,
        color: n.kind === 'free' ? mutedFill() : colorAt(i),
        ratio: n.size / (extra.length ? Math.max(max, extra[0].size) : max)
      })
    )
  }, [childrenOf, selectedPath, complete, settings.showFreeSpace, settings.theme])

  const total = rows.reduce((s, r) => s + r.size, 0) || 1

  return (
    <ScrollArea className="h-full">
      <div className="space-y-2 p-4">
        {rows.map((row, i) => (
          <button
            key={row.name + row.path}
            className="animate-rise block w-full text-left"
            style={{ animationDelay: `${i * 30}ms` }}
            onDoubleClick={() => row.kind === 'dir' && row.path && selectPath(row.path)}
          >
            <div className="mb-0.5 flex items-center justify-between text-xs">
              <span className="truncate pr-3">{row.name}</span>
              <span className="tabular text-muted-foreground">
                {formatBytes(row.size)} · {formatPercent((row.size / total) * 100)}
              </span>
            </div>
            <GrowBar ratio={row.ratio} color={row.color} className="h-5" />
          </button>
        ))}
        {rows.length === 0 ? <p className="animate-fade text-sm text-muted-foreground">Nothing to chart yet.</p> : null}
      </div>
    </ScrollArea>
  )
}
