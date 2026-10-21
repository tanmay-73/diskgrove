import { memo, useCallback, useEffect, useMemo, useRef, useState, type FocusEvent, type MouseEvent } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowDown, ArrowUp, ListChecks, Loader2, ScanSearch, SearchX, Trash2, X } from 'lucide-react'
import { formatBytes, formatDate, formatNumber } from '@shared/format'
import { baseName } from '@shared/paths'
import type { NodeSummary } from '@shared/types'
import { FileGlyph } from '@/components/file-icon'
import { ItemMenu } from '@/components/item-menu'
import { SEARCH_RESULTS_ID } from '@/components/search-box'
import { SearchScopeToggle } from '@/components/search-scope'
import { SizeBar } from '@/components/size-bar'
import { UnreadableMark } from '@/components/unreadable'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useRowSelection } from '@/hooks/use-row-selection'
import { cn } from '@/lib/utils'
import { useScan } from '@/scan-context'

// Two lines per row: the name, then the folder it is in.
const ROW_H = 44

type SortKey = 'name' | 'size' | 'mtime'
interface ResultSort {
  key: SortKey
  dir: 'asc' | 'desc'
}

// Columns follow the pane's width (container queries), so they also adapt when the preview pane or the
// tree narrows the view. Narrow: checkbox · Name (folder underneath) · Size. @xl adds Modified.
const GRID_COLS = cn(
  'grid-cols-[2.25rem_minmax(7rem,1fr)_6rem]',
  '@xl:grid-cols-[2.25rem_minmax(10rem,1fr)_6.5rem_10.5rem]'
)
const GRID_MIN_WIDTH = '17rem'

const CELL = 'flex min-w-0 items-center overflow-hidden whitespace-nowrap border-r border-border/60 px-2.5'
const LAST_CELL = 'flex min-w-0 items-center overflow-hidden whitespace-nowrap px-2.5'
const SIZE_CELL = '@max-xl:border-r-0'
const MTIME_CELL = 'hidden @xl:flex'
const CHECK_CELL = 'flex items-center justify-center border-r border-border/60'

const COLUMNS: Array<{ key: SortKey; label: string; title?: string; className: string }> = [
  { key: 'name', label: 'Name', className: CELL },
  { key: 'size', label: 'Size', className: cn(CELL, SIZE_CELL, 'justify-end') },
  { key: 'mtime', label: 'Modified', title: 'Last modified', className: cn(LAST_CELL, MTIME_CELL) }
]

function compareRows(sort: ResultSort) {
  const dir = sort.dir === 'asc' ? 1 : -1
  return (a: NodeSummary, b: NodeSummary) => {
    if (sort.key === 'name') {
      const byName = a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true })
      if (byName !== 0) return byName * dir
    } else {
      const av = sort.key === 'mtime' ? a.mtime : a.size
      const bv = sort.key === 'mtime' ? b.mtime : b.size
      if (av !== bv) return (av < bv ? -1 : 1) * dir
    }
    return a.path.localeCompare(b.path)
  }
}

/** Splits `name` around the first case-insensitive occurrence of a plain-text query. */
function matchParts(name: string, query: string): [string, string, string] | null {
  if (!query || /[*?]/.test(query)) return null
  const lower = name.toLowerCase()
  // Case mapping can change the length of some characters; then offsets no longer line up.
  if (lower.length !== name.length) return null
  const index = lower.indexOf(query.toLowerCase())
  if (index === -1) return null
  return [name.slice(0, index), name.slice(index, index + query.length), name.slice(index + query.length)]
}

export function SearchView() {
  const {
    rootPath,
    query,
    searchScope,
    searchTarget,
    searchResult,
    searching,
    scanning,
    setSearchScope,
    setPendingDelete,
    setPreviewItem,
    openItem,
    locateItem
  } = useScan()
  const parentRef = useRef<HTMLDivElement>(null)
  const [sort, setSort] = useState<ResultSort>({ key: 'size', dir: 'desc' })
  const term = query.trim()
  const current = searchResult !== null && searchResult.query === term && searchResult.root === searchTarget
  const busy = searching || (term !== '' && !current)

  const rows = useMemo(() => {
    const hits = searchResult?.hits ?? []
    // Results arrive largest first.
    if (sort.key === 'size' && sort.dir === 'desc') return hits
    return [...hits].sort(compareRows(sort))
  }, [searchResult, sort])
  const maxSize = useMemo(() => rows.reduce((max, r) => Math.max(max, r.size), 0) || 1, [rows])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_H,
    overscan: 12
  })
  const scrollToIndex = useCallback((index: number) => virtualizer.scrollToIndex(index), [virtualizer])

  const activate = useCallback(
    (item: NodeSummary) => {
      if (item.kind === 'dir') locateItem(item)
      else void openItem(item.path)
    },
    [locateItem, openItem]
  )

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

  // A different query or folder is a new list; refreshes of the same search keep the checked rows.
  useEffect(() => {
    clearSelection()
    parentRef.current?.scrollTo({ top: 0 })
  }, [searchResult?.query, searchResult?.root, clearSelection])

  // The preview pane follows the focused row.
  useEffect(() => {
    setPreviewItem(cursorItem ?? null)
  }, [cursorItem, setPreviewItem])

  // Arriving from the search box with the keyboard starts at the first result.
  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || cursor !== null || rows.length === 0) return
    if (event.currentTarget.matches(':focus-visible')) focusRow(rows[0].path)
  }

  const scopeName = searchResult ? baseName(searchResult.root) : searchTarget ? baseName(searchTarget) : ''
  const total = searchResult?.total ?? 0
  const truncated = searchResult !== null && total > searchResult.hits.length
  const canWiden = searchScope === 'folder' && searchTarget !== null && searchTarget !== rootPath

  return (
    <div className="@container flex h-full min-h-0 min-w-0 flex-col">
      {/* Always rendered so toggling selection never shifts the rows under the pointer. */}
      <div
        className={cn(
          'flex h-10 shrink-0 items-center gap-2 border-b px-2 text-xs transition-colors duration-150',
          selectedItems.length > 0 && 'bg-primary/10'
        )}
      >
        <SearchScopeToggle />
        <span className="min-w-0 truncate" aria-live="polite">
          {selectedItems.length > 0 ? (
            <>
              <span className="font-medium">
                {formatNumber(selectedItems.length)} of {formatNumber(rows.length)} selected
              </span>
              <span className="ml-2 text-muted-foreground">{formatBytes(selectedBytes)}</span>
            </>
          ) : searchResult ? (
            <>
              <span className="font-medium">
                {formatNumber(total)} {total === 1 ? 'match' : 'matches'}
              </span>
              <span className="text-muted-foreground" title={searchResult.root}>
                {' '}
                in {scopeName}
              </span>
              {truncated ? (
                <span className="text-muted-foreground"> · largest {formatNumber(searchResult.hits.length)} shown</span>
              ) : null}
            </>
          ) : term ? (
            <span className="text-muted-foreground">Searching…</span>
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
            {busy || scanning ? (
              <Loader2 className="size-3.5 animate-spin text-primary" aria-label="Searching" />
            ) : null}
          </span>
        )}
      </div>

      <ScrollArea
        className="min-h-0 min-w-0 flex-1"
        viewportRef={parentRef}
        viewportClassName="select-none outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        viewportProps={{
          id: SEARCH_RESULTS_ID,
          tabIndex: 0,
          role: 'grid',
          'aria-label': 'Search results',
          'aria-multiselectable': true,
          'aria-busy': busy,
          onKeyDown: handleKeyDown,
          onFocus
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
          {COLUMNS.map((col) => {
            const active = sort.key === col.key
            return (
              <button
                key={col.key}
                role="columnheader"
                aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                title={col.title ?? col.label}
                tabIndex={-1}
                className={cn(
                  'h-full gap-1 bg-transparent p-0 px-2.5 text-inherit hover:text-foreground',
                  col.className,
                  active && 'text-foreground'
                )}
                onClick={() =>
                  setSort({
                    key: col.key,
                    dir: active ? (sort.dir === 'desc' ? 'asc' : 'desc') : col.key === 'name' ? 'asc' : 'desc'
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
          <EmptyState
            term={term}
            pending={busy || searchResult === null}
            scopeName={scopeName}
            canWiden={canWiden}
            onWiden={() => setSearchScope('all')}
          />
        ) : (
          <div
            className={cn('relative w-full transition-opacity duration-150', busy && 'opacity-60')}
            style={{ height: virtualizer.getTotalSize(), minWidth: GRID_MIN_WIDTH }}
          >
            {virtualizer.getVirtualItems().map((v) => {
              const item = rows[v.index]
              return (
                <ResultRow
                  key={item.path}
                  item={item}
                  query={searchResult?.query ?? ''}
                  start={v.start}
                  height={v.size}
                  odd={v.index % 2 === 1}
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

function EmptyState({
  term,
  pending,
  scopeName,
  canWiden,
  onWiden
}: {
  term: string
  pending: boolean
  scopeName: string
  canWiden: boolean
  onWiden: () => void
}) {
  if (!term) {
    return (
      <p className="animate-fade p-6 text-sm text-muted-foreground">
        Type in the search box to find files and folders by name.
      </p>
    )
  }
  if (pending) {
    return (
      <p className="animate-fade flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin text-primary" /> Searching {scopeName}…
      </p>
    )
  }
  // A pattern like `report*` reads as "contains"; `*.mp4` already says what it means.
  const suggestContains = /[*?]/.test(term) && !term.startsWith('*')
  return (
    <div className="animate-fade flex flex-col items-start gap-3 p-6 text-sm text-muted-foreground">
      <p className="flex items-center gap-2">
        <SearchX className="size-4 shrink-0" />
        <span className="min-w-0 break-words">
          Nothing named like <span className="font-medium text-foreground">“{term}”</span> in {scopeName}.
        </span>
      </p>
      {suggestContains ? (
        <p className="text-xs">
          With <span className="font-mono">*</span> or <span className="font-mono">?</span> the whole name must match:
          try <span className="font-mono">*{term.replace(/^\*+|\*+$/g, '')}*</span> to find it anywhere in a name.
        </p>
      ) : null}
      {canWiden ? (
        <Button variant="outline" size="sm" onClick={onWiden}>
          <ScanSearch /> Search the entire scan
        </Button>
      ) : null}
    </div>
  )
}

const stop = (event: MouseEvent) => event.stopPropagation()

// Memoized so a scroll frame only renders the rows that come into view.
const ResultRow = memo(function ResultRow({
  item,
  query,
  start,
  height,
  odd,
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
  query: string
  start: number
  height: number
  odd: boolean
  sizeRatio: number
  isSelected: boolean
  isCursor: boolean
  selection: NodeSummary[]
  onRowClick: (event: MouseEvent, item: NodeSummary) => void
  onToggle: (item: NodeSummary) => void
  onActivate: (item: NodeSummary) => void
  onFocusRow: (path: string) => void
}) {
  const parts = matchParts(item.name, query)
  const folder = item.parentPath ?? ''
  return (
    <div
      className="absolute left-0 top-0 w-full"
      style={{ height, minWidth: GRID_MIN_WIDTH, transform: `translateY(${start}px)` }}
    >
      <ItemMenu item={item} selection={selection} locate>
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
            <FileGlyph name={item.name} kind={item.kind} />
            <span className="flex min-w-0 flex-1 flex-col leading-tight">
              <span className="truncate" title={item.name}>
                {parts ? (
                  <>
                    {parts[0]}
                    <mark className="rounded-[2px] bg-primary/25 text-inherit">{parts[1]}</mark>
                    {parts[2]}
                  </>
                ) : (
                  item.name
                )}
              </span>
              <span className="truncate-start mt-0.5 text-[11px] text-muted-foreground" title={folder}>
                <bdi>{folder}</bdi>
              </span>
            </span>
            {item.unreadable ? <UnreadableMark /> : null}
          </span>
          <span role="gridcell" className={cn(CELL, SIZE_CELL, 'relative justify-end tabular')}>
            <SizeBar ratio={sizeRatio} className="inset-y-[9px]" />
            <span className="relative z-10">{formatBytes(item.size)}</span>
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
