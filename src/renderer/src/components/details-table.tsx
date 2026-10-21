import { memo, useCallback, useEffect, useMemo, useRef, type MouseEvent } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown, ArrowUp, ListChecks, Trash2, TriangleAlert, X } from 'lucide-react'
import { formatBytes, formatDate, formatNumber, formatPercent } from '@shared/format'
import type { NodeSummary, SortKey } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ScrollArea } from '@/components/ui/scroll-area'
import { FileGlyph } from '@/components/file-icon'
import { ItemMenu } from '@/components/item-menu'
import { SizeBar } from '@/components/size-bar'
import { UnreadableMark } from '@/components/unreadable'
import { useRowSelection } from '@/hooks/use-row-selection'
import { cn } from '@/lib/utils'
import { useScan } from '@/scan-context'

const ROW_H = 32

const COLS: Array<{
  key: SortKey
  label: string
  title?: string
  width: string
  align?: 'right'
}> = [
  { key: 'name', label: 'Name', width: 'minmax(13rem, 1fr)' },
  { key: 'size', label: 'Size', width: '6.5rem', align: 'right' },
  { key: 'allocated', label: 'Allocated', width: '7rem', align: 'right' },
  { key: 'percent', label: '%', title: 'Percent of parent', width: '4.75rem', align: 'right' },
  { key: 'files', label: 'Files', width: '5.5rem', align: 'right' },
  { key: 'folders', label: 'Folders', width: '6rem', align: 'right' },
  { key: 'mtime', label: 'Modified', title: 'Last modified', width: '11rem' }
]

const CHECK_COL_WIDTH = '2.25rem'
const GRID_TEMPLATE = [CHECK_COL_WIDTH, ...COLS.map((c) => c.width)].join(' ')
const GRID_MIN_WIDTH = '56rem'

function cellClass(index: number, align?: 'right', extra?: string) {
  return cn(
    'min-w-0 overflow-hidden whitespace-nowrap px-2.5',
    index < COLS.length - 1 && 'border-r border-border/60',
    align === 'right' && 'text-right',
    extra
  )
}

const CHECK_CELL_CLASS = 'flex items-center justify-center border-r border-border/60'

export function DetailsTable() {
  const {
    selectedPath,
    childrenOf,
    sort,
    setSort,
    selectPath,
    openItem,
    setPendingDelete,
    setPreviewItem,
    focusRequest,
    clearFocusRequest
  } = useScan()
  const parentRef = useRef<HTMLDivElement>(null)
  const branch = selectedPath ? childrenOf[selectedPath] : undefined
  const parent = branch?.parent
  const rows = useMemo<NodeSummary[]>(() => {
    const all = [...(branch?.dirs ?? []), ...(branch?.files ?? [])]
    const dir = sort.dir === 'asc' ? 1 : -1
    all.sort((a, b) => {
      let av: number | string = 0
      let bv: number | string = 0
      switch (sort.key) {
        case 'name':
          av = a.name.toLowerCase()
          bv = b.name.toLowerCase()
          break
        case 'allocated':
          av = a.allocated
          bv = b.allocated
          break
        case 'files':
          av = a.fileCount
          bv = b.fileCount
          break
        case 'folders':
          av = a.folderCount
          bv = b.folderCount
          break
        case 'mtime':
          av = a.mtime
          bv = b.mtime
          break
        default:
          av = a.size
          bv = b.size
      }
      if (av < bv) return -1 * dir
      if (av > bv) return 1 * dir
      return a.name.localeCompare(b.name)
    })
    return all
  }, [branch, sort])
  const maxSize = parent?.size || rows[0]?.size || 1

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_H,
    overscan: 18
  })

  const activate = useCallback(
    (item: NodeSummary) => {
      if (item.kind === 'dir') selectPath(item.path)
      else void openItem(item.path)
    },
    [selectPath, openItem]
  )

  const scrollToIndex = useCallback((index: number) => virtualizer.scrollToIndex(index), [virtualizer])

  const {
    selected,
    cursor,
    cursorItem,
    selectedItems,
    selectedBytes,
    allSelected,
    headerChecked,
    setCursor,
    clearSelection,
    selectAll,
    toggleItem,
    handleRowClick,
    focusRow,
    requestDelete,
    handleKeyDown
  } = useRowSelection(rows, { onActivate: activate, onDelete: setPendingDelete, scrollToIndex })

  useEffect(() => {
    clearSelection()
  }, [selectedPath, clearSelection])

  // "Show in tree" from search results puts the cursor on the item once its folder has loaded.
  useEffect(() => {
    if (focusRequest && focusRow(focusRequest)) clearFocusRequest()
  }, [focusRequest, focusRow, clearFocusRequest])

  // The preview pane follows the focused row.
  useEffect(() => {
    setPreviewItem(cursorItem ?? null)
  }, [cursorItem, setPreviewItem])

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {/* Always rendered so toggling selection never shifts the rows under the pointer. */}
      <div
        className={cn(
          'flex h-8 shrink-0 items-center gap-3 border-b px-3 text-xs transition-colors duration-150',
          selectedItems.length > 0 && 'bg-primary/10'
        )}
      >
        {selectedItems.length > 0 ? (
          <>
            <span className="font-medium">
              {formatNumber(selectedItems.length)} of {formatNumber(rows.length)} selected
            </span>
            <span className="text-muted-foreground">{formatBytes(selectedBytes)}</span>
            <span className="ml-auto flex items-center gap-1">
              {!allSelected ? (
                <Button variant="ghost" size="sm" className="h-6 px-2" onClick={selectAll}>
                  <ListChecks /> Select all
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-destructive hover:text-destructive"
                onClick={requestDelete}
              >
                <Trash2 /> Delete…
              </Button>
              <Button variant="ghost" size="sm" className="h-6 px-2" onClick={clearSelection}>
                <X /> Clear
              </Button>
            </span>
          </>
        ) : (
          <>
            <span className="font-medium text-muted-foreground">
              {formatNumber(rows.length)} {rows.length === 1 ? 'item' : 'items'}
            </span>
            {parent ? <span className="text-muted-foreground">{formatBytes(parent.size)}</span> : null}
            {parent?.unreadable ? (
              <span className="flex min-w-0 items-center gap-1.5 text-amber-400">
                <TriangleAlert className="size-3.5 shrink-0" />
                <span className="truncate">Couldn't read this folder, so its size is incomplete</span>
              </span>
            ) : null}
          </>
        )}
      </div>
      <ScrollArea
        className="min-h-0 min-w-0 flex-1"
        viewportRef={parentRef}
        viewportClassName="select-none outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        viewportProps={{ tabIndex: 0, role: 'grid', 'aria-multiselectable': true, onKeyDown: handleKeyDown }}
      >
        <div
          className="sticky top-0 z-20 grid h-8 w-full items-stretch border-b bg-muted text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
          style={{ gridTemplateColumns: GRID_TEMPLATE, minWidth: GRID_MIN_WIDTH }}
        >
          <div className={CHECK_CELL_CLASS}>
            <Checkbox
              aria-label={allSelected ? 'Clear selection' : 'Select all'}
              title={allSelected ? 'Clear selection' : 'Select all'}
              tabIndex={-1}
              disabled={rows.length === 0}
              checked={headerChecked}
              onCheckedChange={(value) => (value === true ? selectAll() : clearSelection())}
            />
          </div>
          {COLS.map((col, i) => {
            const active = sort.key === col.key
            return (
              <button
                key={col.key}
                title={col.title ?? col.label}
                tabIndex={-1}
                className={cn(
                  'bg-transparent p-0 text-inherit',
                  cellClass(i, col.align, 'flex h-full items-center gap-1 hover:text-foreground'),
                  col.align === 'right' && 'justify-end',
                  active && 'text-foreground'
                )}
                onClick={() =>
                  setSort({
                    key: col.key,
                    dir: active && sort.dir === 'desc' ? 'asc' : 'desc'
                  })
                }
              >
                <span className="min-w-0 truncate">{col.label}</span>
                {active ? (
                  sort.dir === 'desc' ? (
                    <ArrowDown className="size-3 shrink-0 animate-icon-pop" />
                  ) : (
                    <ArrowUp className="size-3 shrink-0 animate-icon-pop" />
                  )
                ) : null}
              </button>
            )
          })}
        </div>
        {rows.length === 0 ? (
          <p className="animate-fade p-6 text-sm text-muted-foreground">
            {parent?.unreadable
              ? "DiskGrove couldn't read this folder, so its contents aren't included."
              : 'No files in this folder yet. Scan results appear as they are collected.'}
          </p>
        ) : (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize(), minWidth: GRID_MIN_WIDTH }}>
            {virtualizer.getVirtualItems().map((v) => {
              const item = rows[v.index]
              return (
                <DetailRow
                  key={item.path}
                  item={item}
                  start={v.start}
                  height={v.size}
                  odd={v.index % 2 === 1}
                  percent={parent?.size ? (item.size / parent.size) * 100 : 0}
                  sizeRatio={item.size / maxSize}
                  isSelected={selected.has(item.path)}
                  isCursor={cursor === item.path}
                  selection={selectedItems}
                  onRowClick={handleRowClick}
                  onToggle={toggleItem}
                  onActivate={activate}
                  onFocusRow={setCursor}
                />
              )
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}

const stop = (event: MouseEvent) => event.stopPropagation()

// Memoized so a scroll frame only renders the rows that come into view.
const DetailRow = memo(function DetailRow({
  item,
  start,
  height,
  odd,
  percent,
  sizeRatio,
  isSelected,
  isCursor,
  selection,
  onRowClick,
  onToggle,
  onActivate,
  onFocusRow
}: {
  item: NodeSummary
  start: number
  height: number
  odd: boolean
  percent: number
  sizeRatio: number
  isSelected: boolean
  isCursor: boolean
  selection: NodeSummary[]
  onRowClick: (event: MouseEvent, item: NodeSummary) => void
  onToggle: (item: NodeSummary) => void
  onActivate: (item: NodeSummary) => void
  onFocusRow: (path: string) => void
}) {
  return (
    <div
      className="absolute left-0 top-0 w-full"
      style={{ height, minWidth: GRID_MIN_WIDTH, transform: `translateY(${start}px)` }}
    >
      <ItemMenu item={item} selection={selection}>
        <div
          role="row"
          aria-selected={isSelected}
          className={cn(
            'grid h-full w-full cursor-default items-stretch border-b border-border/40 text-[13px] transition-colors duration-150 hover:bg-accent/60',
            odd && 'bg-muted/30',
            isSelected && 'bg-primary/15 hover:bg-primary/20',
            isCursor && 'shadow-[inset_0_0_0_1px_var(--ring)]'
          )}
          style={{ gridTemplateColumns: GRID_TEMPLATE }}
          onClick={(event) => onRowClick(event, item)}
          onDoubleClick={() => onActivate(item)}
          onContextMenu={() => onFocusRow(item.path)}
        >
          <span className={CHECK_CELL_CLASS}>
            <Checkbox
              aria-label={`Select ${item.name}`}
              tabIndex={-1}
              checked={isSelected}
              onCheckedChange={() => onToggle(item)}
              onClick={stop}
              onDoubleClick={stop}
            />
          </span>
          <span className={cellClass(0, undefined, 'flex items-center gap-2')}>
            <FileGlyph name={item.name} kind={item.kind} />
            <span className="min-w-0 flex-1 truncate" title={item.name}>
              {item.name}
            </span>
            {item.unreadable ? <UnreadableMark /> : null}
          </span>
          <span className={cellClass(1, 'right', 'relative flex items-center justify-end tabular')}>
            <SizeBar ratio={sizeRatio} className="inset-y-[5px]" />
            <span className="relative z-10">{formatBytes(item.size)}</span>
          </span>
          <span className={cellClass(2, 'right', 'flex items-center justify-end tabular text-muted-foreground')}>
            {formatBytes(item.allocated)}
          </span>
          <span className={cellClass(3, 'right', 'flex items-center justify-end tabular')}>
            {formatPercent(percent)}
          </span>
          <span className={cellClass(4, 'right', 'flex items-center justify-end tabular')}>
            {item.kind === 'dir' ? formatNumber(item.fileCount) : '—'}
          </span>
          <span className={cellClass(5, 'right', 'flex items-center justify-end tabular')}>
            {item.kind === 'dir' ? formatNumber(item.folderCount) : '—'}
          </span>
          <span
            className={cellClass(6, undefined, 'flex items-center text-muted-foreground')}
            title={formatDate(item.mtime)}
          >
            <span className="min-w-0 flex-1 truncate">{formatDate(item.mtime)}</span>
          </span>
        </div>
      </ItemMenu>
    </div>
  )
})
