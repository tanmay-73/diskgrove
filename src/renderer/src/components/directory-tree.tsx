import { memo, useEffect, useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronRight } from 'lucide-react'
import { formatBytes } from '@shared/format'
import type { NodeSummary } from '@shared/types'
import { FileGlyph } from '@/components/file-icon'
import { ItemMenu } from '@/components/item-menu'
import { SizeBar } from '@/components/size-bar'
import { UnreadableMark } from '@/components/unreadable'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { useScan } from '@/scan-context'

interface TreeRow {
  node: NodeSummary
  depth: number
}

export function DirectoryTree() {
  const { rootPath, childrenOf, expanded, selectedPath, selectPath, toggleExpanded, progress } = useScan()
  const parentRef = useRef<HTMLDivElement>(null)

  const rows = useMemo(() => {
    if (!rootPath) return []
    const rootChildren = childrenOf[rootPath]
    const rootNode: NodeSummary = rootChildren?.parent ?? {
      path: rootPath,
      name: rootPath,
      kind: 'dir',
      size: progress?.bytes ?? 0,
      allocated: progress?.allocated ?? 0,
      mtime: 0,
      atime: 0,
      ctime: 0,
      fileCount: progress?.files ?? 0,
      folderCount: progress?.folders ?? 0,
      ext: '',
      parentPath: null,
      hasSubdirs: true
    }
    const out: TreeRow[] = []
    const walk = (node: NodeSummary, depth: number) => {
      out.push({ node, depth })
      if (!expanded[node.path]) return
      const kids = childrenOf[node.path]?.dirs ?? []
      for (const child of kids) walk(child, depth + 1)
    }
    walk(rootNode, 0)
    return out
  }, [rootPath, childrenOf, expanded, progress])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 28,
    overscan: 16
  })

  const rootSize = rows[0]?.node.size || 1

  // Bring the selected folder into view once, e.g. after "Show in tree" expands a deep path.
  const revealed = useRef<string | null>(null)
  useEffect(() => {
    if (!selectedPath || revealed.current === selectedPath) return
    const index = rows.findIndex((row) => row.node.path === selectedPath)
    if (index === -1) return
    revealed.current = selectedPath
    virtualizer.scrollToIndex(index, { align: 'auto' })
  }, [rows, selectedPath, virtualizer])

  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar">
      <div className="flex h-8 items-center border-b px-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Directory tree
      </div>
      <ScrollArea orientation="vertical" className="min-h-0 flex-1" viewportRef={parentRef}>
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((v) => {
            const row = rows[v.index]
            return (
              <TreeRowView
                key={row.node.path}
                node={row.node}
                depth={row.depth}
                start={v.start}
                height={v.size}
                ratio={row.node.size / rootSize}
                selected={selectedPath === row.node.path}
                open={Boolean(expanded[row.node.path])}
                selectPath={selectPath}
                toggleExpanded={toggleExpanded}
              />
            )
          })}
        </div>
      </ScrollArea>
    </div>
  )
}

// Memoized so a scroll frame only renders the rows that come into view.
const TreeRowView = memo(function TreeRowView({
  node,
  depth,
  start,
  height,
  ratio,
  selected,
  open,
  selectPath,
  toggleExpanded
}: {
  node: NodeSummary
  depth: number
  start: number
  height: number
  ratio: number
  selected: boolean
  open: boolean
  selectPath: (path: string) => void
  toggleExpanded: (path: string) => void
}) {
  return (
    <div className="absolute left-0 top-0 w-full" style={{ height, transform: `translateY(${start}px)` }}>
      <ItemMenu item={node}>
        <button
          className={cn(
            'relative flex h-7 w-full items-center gap-1 pr-3 text-left text-[13px] transition-colors duration-150 hover:bg-accent/70',
            selected && 'bg-primary/15 hover:bg-primary/20'
          )}
          style={{ paddingLeft: 6 + depth * 14 }}
          onClick={() => selectPath(node.path)}
          onDoubleClick={() => toggleExpanded(node.path)}
        >
          <SizeBar ratio={ratio} />
          <span
            className="relative z-10 flex size-4 items-center justify-center text-muted-foreground"
            onClick={(e) => {
              e.stopPropagation()
              toggleExpanded(node.path)
            }}
          >
            <ChevronRight className={cn('size-3.5 transition-transform duration-200 ease-out', open && 'rotate-90')} />
          </span>
          <FileGlyph name={node.name} kind="dir" isRoot={depth === 0} className="relative z-10" />
          <span className="relative z-10 min-w-0 flex-1 truncate">{node.name}</span>
          {node.unreadable ? <UnreadableMark className="relative z-10" /> : null}
          <span className="relative z-10 shrink-0 whitespace-nowrap tabular text-xs text-muted-foreground">
            {formatBytes(node.size)}
          </span>
        </button>
      </ItemMenu>
    </div>
  )
})
