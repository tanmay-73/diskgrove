import { useEffect, useState } from 'react'
import { Loader2, Square } from 'lucide-react'
import { formatBytes, formatCount, formatDate } from '@shared/format'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useScan } from '@/scan-context'

export function DuplicatesView() {
  const { duplicates, dupLoading, dupProgress, loadDuplicates, cancelDuplicates, revealItem } = useScan()
  const [stopping, setStopping] = useState(false)
  const wasted = duplicates.reduce((s, g) => s + g.wasted, 0)

  useEffect(() => {
    if (!dupLoading) setStopping(false)
  }, [dupLoading])

  const stop = () => {
    setStopping(true)
    void cancelDuplicates()
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b px-4 py-2">
        <Button size="sm" onClick={() => void loadDuplicates()} disabled={dupLoading}>
          {dupLoading ? <Loader2 className="animate-spin" /> : null}
          {dupLoading ? 'Searching…' : 'Find duplicates'}
        </Button>
        {dupLoading ? (
          <Button size="sm" variant="outline" aria-label="Stop duplicate search" onClick={stop} disabled={stopping}>
            <Square />
            {stopping ? 'Stopping…' : 'Stop'}
          </Button>
        ) : null}
        {dupProgress && dupProgress.phase !== 'done' ? (
          <span className="text-xs text-muted-foreground">
            {dupProgress.phase === 'grouping'
              ? 'Grouping by size…'
              : dupProgress.phase === 'cancelled'
                ? `Stopped after ${dupProgress.hashed}/${dupProgress.total} — showing matches verified so far`
                : `Hashing ${dupProgress.hashed}/${dupProgress.total}`}
          </span>
        ) : null}
        {duplicates.length > 0 ? (
          <span className="text-xs text-muted-foreground">
            {formatCount(duplicates.length, 'group')} ·{formatBytes(wasted)} recoverable
          </span>
        ) : null}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-4">
          {dupLoading && duplicates.length === 0 ? (
            <div className="space-y-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-24 animate-pulse rounded-lg border bg-muted/40" />
              ))}
            </div>
          ) : null}
          {duplicates.map((group, i) => (
            <div
              key={group.hash}
              className="animate-rise mb-4 rounded-lg border bg-card p-3"
              style={{ animationDelay: `${Math.min(i, 10) * 40}ms` }}
            >
              <div className="mb-2 flex items-center justify-between text-sm">
                <span className="font-medium">
                  {formatBytes(group.size)} · {group.count} copies · wasted {formatBytes(group.wasted)}
                </span>
                <span className="font-mono text-[10px] text-muted-foreground">{group.hash.slice(0, 12)}</span>
              </div>
              <ul className="space-y-1 text-xs">
                {group.files.map((file) => (
                  <li key={file.path}>
                    <button
                      className="truncate text-left transition-colors duration-150 hover:text-primary hover:underline"
                      onClick={() => void revealItem(file.path)}
                    >
                      {file.path}
                      <span className="ml-2 text-muted-foreground">{formatDate(file.mtime)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {!dupLoading && duplicates.length === 0 ? (
            <p className="animate-fade text-sm text-muted-foreground">
              Duplicate search groups files of equal size, fingerprints them (SHA-256 of the start and end of each
              file), then verifies every match by hashing the full file contents. Run it on a selected folder after a
              scan.
            </p>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  )
}
