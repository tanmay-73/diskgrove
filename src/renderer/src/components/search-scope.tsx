import type { KeyboardEvent } from 'react'
import { FolderSearch, ScanSearch, type LucideIcon } from 'lucide-react'
import type { SearchScope } from '@shared/types'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useScan } from '@/scan-context'

export const SEARCH_SCOPES: ReadonlyArray<{ id: SearchScope; label: string; icon: LucideIcon }> = [
  { id: 'folder', label: 'Selected folder', icon: FolderSearch },
  { id: 'all', label: 'Entire scan', icon: ScanSearch }
]

export function scopeInfo(scope: SearchScope) {
  return SEARCH_SCOPES.find((s) => s.id === scope) ?? SEARCH_SCOPES[0]
}

/**
 * Segmented control for the search scope. Labels need an `@container` ancestor of at least `@xl`;
 * narrower panes show icons, with the label and folder in a tooltip.
 */
export function SearchScopeToggle({ className }: { className?: string }) {
  const { searchScope, setSearchScope, selectedPath, rootPath } = useScan()

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    const next = searchScope === 'folder' ? 'all' : 'folder'
    setSearchScope(next)
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-scope="${next}"]`)?.focus()
  }

  return (
    <div
      role="radiogroup"
      aria-label="Search in"
      className={cn('inline-flex shrink-0 items-center gap-0.5 rounded-md border bg-muted/50 p-0.5', className)}
      onKeyDown={onKeyDown}
    >
      {SEARCH_SCOPES.map(({ id, label, icon: Icon }) => {
        const active = searchScope === id
        const folder = id === 'folder' ? (selectedPath ?? rootPath) : rootPath
        return (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <button
                type="button"
                role="radio"
                data-scope={id}
                aria-checked={active}
                aria-label={label}
                tabIndex={active ? 0 : -1}
                className={cn(
                  'inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-[5px] px-2 text-xs font-medium text-muted-foreground transition-[background-color,color,box-shadow] duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active && 'bg-background text-foreground shadow-sm'
                )}
                onClick={() => setSearchScope(id)}
              >
                <Icon className="size-3.5 shrink-0" />
                <span className="hidden @xl:inline">{label}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-sm break-all">
              {label}
              {folder ? <span className="block text-muted-foreground">{folder}</span> : null}
            </TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}
