import { ChevronRight } from 'lucide-react'
import { pathCrumbs } from '@shared/paths'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useScan } from '@/scan-context'

export function Breadcrumbs() {
  const { selectedPath, rootPath, selectPath } = useScan()
  if (!selectedPath || !rootPath) return null
  const parts = pathCrumbs(rootPath, selectedPath)
  return (
    <ScrollArea orientation="horizontal" className="h-8 shrink-0 border-b" viewportClassName="[&>div]:h-full">
      <div className="flex h-full w-max min-w-full items-center gap-1 px-3 text-xs">
        {parts.map((p, i) => (
          <span key={p.path} className="flex items-center gap-1">
            {i > 0 ? <ChevronRight className="size-3 text-muted-foreground" /> : null}
            <button
              className="rounded px-1 py-0.5 transition-colors duration-150 hover:bg-accent"
              onClick={() => selectPath(p.path)}
            >
              {p.label}
            </button>
          </span>
        ))}
      </div>
    </ScrollArea>
  )
}
