import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { FolderX, Link2Off, ListChecks, Loader2, Trash2, X } from 'lucide-react'
import { formatDate, formatNumber } from '@shared/format'
import { baseName } from '@shared/paths'
import type { BrokenLink, NodeSummary } from '@shared/types'
import { FileGlyph } from '@/components/file-icon'
import { ItemMenu } from '@/components/item-menu'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useRowSelection } from '@/hooks/use-row-selection'
import { cn } from '@/lib/utils'
import { useScan } from '@/scan-context'

// Two lines per row: the name, then the folder it is in.
const ROW_H = 44

type Kind = 'folders' | 'links'

// Columns follow the pane's width (container queries). Narrow: checkbox · Name (folder underneath) · detail.
// @xl adds Modified.
const GRID_COLS = cn(
  'grid-cols-[2.25rem_minmax(7rem,1fr)_minmax(6rem,0.6fr)]',
  '@xl:grid-cols-[2.25rem_minmax(10rem,1fr)_minmax(8rem,0.8fr)_10.5rem]'
)
const GRID_MIN_WIDTH = '17rem'

const CELL = 'flex min-w-0 items-center overflow-hidden whitespace-nowrap border-r border-border/60 px-2.5'
const LAST_CELL = 'flex min-w-0 items-center overflow-hidden whitespace-nowrap px-2.5'
const DETAIL_CELL = '@max-xl:border-r-0'
const MTIME_CELL = 'hidden @xl:flex'
const CHECK_CELL = 'flex items-center justify-center border-r border-border/60'

function nestedLabel(item: NodeSummary): string {
  return item.folderCount === 0 ? '—' : `${formatNumber(item.folderCount)} inside`
}

export function EmptyFoldersView() {
  const {
    selectedPath,
    emptyFolders,
    brokenLinks,
    scanning,
    setPendingDelete,
    setPreviewItem,
    locateItem,
    revealItem
  } = useScan()
  const parentRef = useRef<HTMLDivElement>(null)
  const [kind, setKind] = useState<Kind>('folders')
  const result = kind === 'folders' ? emptyFolders : brokenLinks
  const current = result !== null && result.root === selectedPath
  const rows: NodeSummary[] = useMemo(
    () => (kind === 'folders' ? (emptyFolders?.hits ?? []) : (brokenLinks?.links ?? [])),
    [kind, emptyFolders, brokenLinks]
  )
  const total = result?.total ?? 0

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_H,
    overscan: 12
  })
  const scrollToIndex = useCallback((index: number) => virtualizer.scrollToIndex(index), [virtualizer])

  // A folder is shown in the tree; a broken link has nothing to open, so it is shown in its folder.
  const activate = useCallback(
    (item: NodeSummary) => {
      if (item.kind === 'dir') locateItem(item)
      else void revealItem(item.path)
    },
    [locateItem, revealItem]
  )

  const {
    selected,
    cursor,
    cursorItem,
    selectedItems,
    allSelected,
    headerChecked,
    setCursor,
    clearSelection,
    selectAll,
    toggleItem,
    handleRowClick,
    requestDelete,
    handleKeyDown
  } = useRowSelection(rows, { onActivate: activate, onDelete: setPendingDelete, scrollToIndex })

  // Another list or folder starts over; refreshes of the same one keep the checked rows.
  useEffect(() => {
    clearSelection()
    parentRef.current?.scrollTo({ top: 0 })
  }, [kind, result?.root, clearSelection])

  // The preview pane follows the focused folder. A broken link has no contents to preview.
  useEffect(() => {
    setPreviewItem(cursorItem?.kind === 'dir' ? cursorItem : null)
  }, [cursorItem, setPreviewItem])

  const scopeName = selectedPath ? baseName(selectedPath) : ''
  const truncated = total > rows.length

  return (
    <div className="@container flex h-full min-h-0 min-w-0 flex-col">
      {/* Always rendered so toggling selection never shifts the rows under the pointer. */}
      <div
        className={cn(
          'flex h-10 shrink-0 items-center gap-2 border-b px-2 text-xs transition-colors duration-150',
          selectedItems.length > 0 && 'bg-primary/10'
        )}
      >
        <div role="radiogroup" aria-label="List" className="flex shrink-0 items-center rounded-md border p-0.5">
          <KindButton
            active={kind === 'folders'}
            label="Empty folders"
            count={emptyFolders?.total}
            icon={<FolderX />}
            onClick={() => setKind('folders')}
          />
          <KindButton
            active={kind === 'links'}
            label="Broken links"
            count={brokenLinks?.total}
            icon={<Link2Off />}
            onClick={() => setKind('links')}
          />
        </div>
        <span className="min-w-0 truncate" aria-live="polite">
          {selectedItems.length > 0 ? (
            <span className="font-medium">
              {formatNumber(selectedItems.length)} of {formatNumber(rows.length)} selected
            </span>
          ) : current ? (
            <>
              <span className="text-muted-foreground" title={result.root}>
                in {scopeName}
              </span>
              {truncated ? (
                <span className="text-muted-foreground"> · first {formatNumber(rows.length)} shown</span>
              ) : null}
            </>
          ) : null}
        </span>
        {selectedItems.length > 0 ? (
          <span className="ml-auto flex shrink-0 items-center gap-0.5">
            {!allSelected ? (
              <Button variant="ghost" size="sm" className="h-6 px-2" aria-label="Select all" onClick={selectAll}>
                <ListChecks /> <span className="hidden @3xl:inline">Select all</span>
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-destructive hover:text-destructive"
              aria-label="Delete selected"
              onClick={requestDelete}
            >
              <Trash2 /> <span className="hidden @3xl:inline">Delete…</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2"
              aria-label="Clear selection"
              onClick={clearSelection}
            >
              <X /> <span className="hidden @3xl:inline">Clear</span>
            </Button>
          </span>
        ) : (
          <span className="ml-auto flex shrink-0 items-center gap-1.5 text-muted-foreground">
            {scanning ? (
              <span className="hidden @lg:inline" title="Results update while the scan runs">
                Scan in progress
              </span>
            ) : null}
            {scanning || !current ? (
              <Loader2 className="size-3.5 animate-spin text-primary" aria-label="Loading" />
            ) : null}
          </span>
        )}
      </div>

      <ScrollArea
        className="min-h-0 min-w-0 flex-1"
        viewportRef={parentRef}
        viewportClassName="select-none outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        viewportProps={{
          tabIndex: 0,
          role: 'grid',
          'aria-label': kind === 'folders' ? 'Empty folders' : 'Broken links',
          'aria-multiselectable': true,
          'aria-busy': !current,
          onKeyDown: handleKeyDown
        }}
      >
        <div
          role="row"
          className={cn(
            'sticky top-0 z-20 grid h-8 w-full items-stretch border-b bg-muted text-[11px] font-semibold uppercase tracking-wide text-muted-foreground',
            GRID_COLS
          )}
          style={{ minWidth: GRID_MIN_WIDTH }}
        >
          <div role="columnheader" className={CHECK_CELL}>
            <Checkbox
              aria-label={allSelected ? 'Clear selection' : 'Select all'}
              title={allSelected ? 'Clear selection' : 'Select all'}
              tabIndex={-1}
              disabled={rows.length === 0}
              checked={headerChecked}
              onCheckedChange={(value) => (value === true ? selectAll() : clearSelection())}
            />
          </div>
          <span role="columnheader" className={CELL}>
            Name
          </span>
          {kind === 'folders' ? (
            <span role="columnheader" className={cn(CELL, DETAIL_CELL)} title="Empty folders inside this one">
              Empty subfolders
            </span>
          ) : (
            <span role="columnheader" className={cn(CELL, DETAIL_CELL)} title="Where the link points">
              Target
            </span>
          )}
          <span role="columnheader" className={cn(LAST_CELL, MTIME_CELL)} title="Last modified">
            Modified
          </span>
        </div>

        {rows.length === 0 ? (
          <EmptyState kind={kind} pending={!current} scanning={scanning} scopeName={scopeName} />
        ) : (
          <div
            className={cn('relative w-full transition-opacity duration-150', !current && 'opacity-60')}
            style={{ height: virtualizer.getTotalSize(), minWidth: GRID_MIN_WIDTH }}
          >
            {virtualizer.getVirtualItems().map((v) => {
              const item = rows[v.index]
              return (
                <CleanupRow
                  key={item.path}
                  item={item}
                  detail={kind === 'folders' ? nestedLabel(item) : (item as BrokenLink).target || '—'}
                  start={v.start}
                  height={v.size}
                  odd={v.index % 2 === 1}
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

function KindButton({
  active,
  label,
  count,
  icon,
  onClick
}: {
  active: boolean
  label: string
  count: number | undefined
  icon: ReactNode
  onClick: () => void
}) {
  return (
    <Button
      role="radio"
      aria-checked={active}
      aria-label={label}
      variant={active ? 'secondary' : 'ghost'}
      size="sm"
      className={cn('h-6 gap-1.5 px-2', active && 'text-foreground')}
      onClick={onClick}
    >
      {icon}
      <span className="hidden @lg:inline">{label}</span>
      {count !== undefined ? <span className="tabular text-muted-foreground">{formatNumber(count)}</span> : null}
    </Button>
  )
}

function EmptyState({
  kind,
  pending,
  scanning,
  scopeName
}: {
  kind: Kind
  pending: boolean
  scanning: boolean
  scopeName: string
}) {
  if (pending) {
    return (
      <p className="animate-fade flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin text-primary" /> Looking through {scopeName}…
      </p>
    )
  }
  return (
    <p className="animate-fade p-6 text-sm text-muted-foreground">
      {kind === 'folders'
        ? `No empty folders in ${scopeName}${scanning ? ' so far' : ''}. A folder counts as empty when it holds no files at any depth, and nothing the scan skipped, such as hidden files or links.`
        : `No broken links in ${scopeName}${scanning ? ' so far' : ''}. A link is broken when the file or folder it points to no longer exists.`}
    </p>
  )
}

const stop = (event: MouseEvent) => event.stopPropagation()

// Memoized so a scroll frame only renders the rows that come into view.
const CleanupRow = memo(function CleanupRow({
  item,
  detail,
  start,
  height,
  odd,
  isSelected,
  isCursor,
  selection,
  onRowClick,
  onToggle,
  onActivate,
  onFocusRow
}: {
  item: NodeSummary
  detail: string
  start: number
  height: number
  odd: boolean
  isSelected: boolean
  isCursor: boolean
  selection: NodeSummary[]
  onRowClick: (event: MouseEvent, item: NodeSummary) => void
  onToggle: (item: NodeSummary) => void
  onActivate: (item: NodeSummary) => void
  onFocusRow: (path: string) => void
}) {
  const folder = item.parentPath ?? ''
  const isLink = item.kind === 'file'
  return (
    <div
      className="absolute left-0 top-0 w-full"
      style={{ height, minWidth: GRID_MIN_WIDTH, transform: `translateY(${start}px)` }}
    >
      <ItemMenu item={item} selection={selection} locate={!isLink} canOpen={!isLink}>
        <div
          role="row"
          aria-selected={isSelected}
          className={cn(
            'grid h-full w-full cursor-default items-stretch border-b border-border/40 text-[13px] transition-colors duration-150 hover:bg-accent/60',
            GRID_COLS,
            odd && 'bg-muted/30',
            isSelected && 'bg-primary/15 hover:bg-primary/20',
            isCursor && 'shadow-[inset_0_0_0_1px_var(--ring)]'
          )}
          onClick={(event) => onRowClick(event, item)}
          onDoubleClick={() => onActivate(item)}
          onContextMenu={() => onFocusRow(item.path)}
        >
          <span role="gridcell" className={CHECK_CELL}>
            <Checkbox
              aria-label={`Select ${item.name}`}
              tabIndex={-1}
              checked={isSelected}
              onCheckedChange={() => onToggle(item)}
              onClick={stop}
              onDoubleClick={stop}
            />
          </span>
          <span role="gridcell" className={cn(CELL, 'gap-2')}>
            {isLink ? (
              <Link2Off className="size-4 shrink-0 text-destructive" aria-label="Broken link" />
            ) : (
              <FileGlyph name={item.name} kind="dir" />
            )}
            <span className="flex min-w-0 flex-1 flex-col leading-tight">
              <span className="truncate" title={item.name}>
                {item.name}
              </span>
              <span className="truncate-start mt-0.5 text-[11px] text-muted-foreground" title={folder}>
                <bdi>{folder}</bdi>
              </span>
            </span>
          </span>
          <span role="gridcell" className={cn(CELL, DETAIL_CELL, 'text-muted-foreground', !isLink && 'tabular')}>
            <span className={cn('min-w-0 flex-1 truncate', isLink && 'truncate-start')} title={detail}>
              <bdi>{detail}</bdi>
            </span>
          </span>
          <span role="gridcell" className={cn(LAST_CELL, MTIME_CELL, 'text-muted-foreground')}>
            <span className="min-w-0 flex-1 truncate" title={formatDate(item.mtime)}>
              {formatDate(item.mtime)}
            </span>
          </span>
        </div>
      </ItemMenu>
    </div>
  )
})
