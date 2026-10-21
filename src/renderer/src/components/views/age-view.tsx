import { useState } from 'react'
import { formatBytes, formatCount, formatPercent } from '@shared/format'
import { FileGroupDialog, type FileGroupTarget } from '@/components/file-group-dialog'
import { GrowBar } from '@/components/size-bar'
import { ScrollArea } from '@/components/ui/scroll-area'
import { colorAt } from '@/lib/palette'
import { useScan } from '@/scan-context'

export function AgeView() {
  const { age } = useScan()
  const [listed, setListed] = useState<FileGroupTarget | null>(null)
  const max = Math.max(...age.map((a) => a.size), 1)
  return (
    <ScrollArea className="h-full">
      <div className="p-4">
        <p className="mb-4 text-sm text-muted-foreground">
          Distribution of occupied space by last modified date in the selected branch. Click a period to list its files.
        </p>
        <div className="-mx-2 space-y-1">
          {age.map((bucket, i) => (
            <button
              key={bucket.id}
              type="button"
              disabled={bucket.count === 0}
              title={bucket.count === 0 ? undefined : 'List these files'}
              className="animate-rise block w-full rounded-md px-2 py-1.5 text-left transition-colors duration-150 enabled:hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default"
              style={{ animationDelay: `${i * 40}ms` }}
              onClick={() => setListed({ group: { by: 'age', id: bucket.id }, title: bucket.label })}
            >
              <div className="mb-1 flex items-center justify-between text-sm">
                <span>{bucket.label}</span>
                <span className="tabular text-xs text-muted-foreground">
                  {formatCount(bucket.count, 'file')} ·{formatBytes(bucket.size)} · {formatPercent(bucket.percent)}
                </span>
              </div>
              <GrowBar ratio={bucket.size / max} color={colorAt(i)} className="h-6" />
            </button>
          ))}
        </div>
      </div>
      <FileGroupDialog target={listed} onClose={() => setListed(null)} />
    </ScrollArea>
  )
}
