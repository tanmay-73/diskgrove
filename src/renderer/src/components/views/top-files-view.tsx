import { formatBytes, formatDate, formatPercent } from '@shared/format'
import type { NodeSummary } from '@shared/types'
import { FileGlyph } from '@/components/file-icon'
import { ItemMenu } from '@/components/item-menu'
import { SizeBar } from '@/components/size-bar'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { useScan } from '@/scan-context'

// Columns follow the pane's width (container queries), not the window's, so they also adapt when the
// preview pane or sidebar narrows the view. Narrow: # · Name (folder underneath) · Size.
// @md adds %, @2xl adds Modified, @4xl moves the folder into its own column.
const GRID_COLS = cn(
  'grid-cols-[2.75rem_minmax(9rem,1fr)_6.5rem]',
  '@md:grid-cols-[2.75rem_minmax(9rem,1fr)_6.5rem_4.75rem]',
  '@2xl:grid-cols-[2.75rem_minmax(11rem,1fr)_6.5rem_4.75rem_11rem]',
  '@4xl:grid-cols-[2.75rem_minmax(12rem,1fr)_minmax(12rem,1.4fr)_6.5rem_4.75rem_11rem]'
)
const GRID_MIN_WIDTH = '19rem'

const CELL = 'flex min-w-0 items-center overflow-hidden whitespace-nowrap border-r border-border/60 px-2.5'
const LAST_CELL = 'flex min-w-0 items-center overflow-hidden whitespace-nowrap px-2.5'
const PCT_CELL = 'hidden @md:flex'
const MTIME_CELL = 'hidden @2xl:flex'
const FOLDER_CELL = 'hidden @4xl:flex'

/** Containing folder of a file, keeping the separator for roots like `C:\` or `/`. */
function folderOf(file: NodeSummary) {
  const dir = file.path.slice(0, file.path.length - file.name.length)
  const trimmed = dir.replace(/[\\/]+$/, '')
  return trimmed === '' || trimmed.endsWith(':') ? dir : trimmed
}

export function TopFilesView() {
  const { topFiles, selectedNode, revealItem, previewItem, setPreviewItem } = useScan()
  const total = selectedNode?.size || 1
  const maxSize = topFiles.reduce((max, f) => Math.max(max, f.size), 0) || 1

  return (
    <div className="@container h-full min-h-0 min-w-0">
      <ScrollArea className="h-full min-w-0" viewportClassName="select-none" viewportProps={{ role: 'grid' }}>
        <div
          role="row"
          className={cn(
            'sticky top-0 z-20 grid h-8 w-full items-stretch border-b bg-muted text-[11px] font-semibold uppercase tracking-wide text-muted-foreground',
            GRID_COLS
          )}
          style={{ minWidth: GRID_MIN_WIDTH }}
        >
          <span role="columnheader" className={cn(CELL, 'justify-end')} title="Rank by size">
            #
          </span>
          <span role="columnheader" className={CELL}>
            Name
          </span>
          <span role="columnheader" className={cn(CELL, FOLDER_CELL)}>
            Folder
          </span>
          <span role="columnheader" className={cn(CELL, 'justify-end @max-md:border-r-0')}>
            Size
          </span>
          <span
            role="columnheader"
            className={cn(CELL, PCT_CELL, 'justify-end @max-2xl:border-r-0')}
            title="Percent of selected folder"
          >
            %
          </span>
          <span role="columnheader" className={cn(LAST_CELL, MTIME_CELL)} title="Last modified">
            Modified
          </span>
        </div>

        {topFiles.length === 0 ? (
          <p className="animate-fade p-6 text-sm text-muted-foreground">
            Largest files will appear after the scan has found files.
          </p>
        ) : (
          <div style={{ minWidth: GRID_MIN_WIDTH }}>
            {topFiles.map((file, i) => {
              const folder = folderOf(file)
              const isActive = previewItem?.path === file.path
              return (
                <ItemMenu key={file.path} item={file}>
                  <div
                    role="row"
                    aria-selected={isActive}
                    className={cn(
                      'grid min-h-8 w-full cursor-default items-stretch border-b border-border/40 text-[13px] transition-colors duration-150 hover:bg-accent/60',
                      GRID_COLS,
                      i % 2 === 1 && 'bg-muted/30',
                      isActive && 'bg-primary/15 hover:bg-primary/20'
                    )}
                    title={file.path}
                    onClick={() => setPreviewItem(file)}
                    onDoubleClick={() => void revealItem(file.path)}
                  >
                    <span role="gridcell" className={cn(CELL, 'justify-end tabular text-muted-foreground')}>
                      {i + 1}
                    </span>
                    <span role="gridcell" className={cn(CELL, 'gap-2 py-1')}>
                      <FileGlyph name={file.name} kind="file" />
                      <span className="flex min-w-0 flex-1 flex-col leading-tight">
                        <span className="truncate">{file.name}</span>
                        {/* Below @4xl the folder has no column of its own, so it sits under the name. */}
                        <span className="truncate text-[11px] text-muted-foreground @4xl:hidden">{folder}</span>
                      </span>
                    </span>
                    <span role="gridcell" className={cn(CELL, FOLDER_CELL, 'text-muted-foreground')}>
                      <span className="min-w-0 flex-1 truncate">{folder}</span>
                    </span>
                    <span role="gridcell" className={cn(CELL, 'relative justify-end tabular @max-md:border-r-0')}>
                      <SizeBar ratio={file.size / maxSize} className="inset-y-[5px]" />
                      <span className="relative z-10">{formatBytes(file.size)}</span>
                    </span>
                    <span role="gridcell" className={cn(CELL, PCT_CELL, 'justify-end tabular @max-2xl:border-r-0')}>
                      {formatPercent((file.size / total) * 100)}
                    </span>
                    <span role="gridcell" className={cn(LAST_CELL, MTIME_CELL, 'text-muted-foreground')}>
                      <span className="min-w-0 flex-1 truncate">{formatDate(file.mtime)}</span>
                    </span>
                  </div>
                </ItemMenu>
              )
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}
