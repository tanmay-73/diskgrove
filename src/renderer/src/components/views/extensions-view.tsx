import { useState } from 'react'
import { formatBytes, formatNumber, formatPercent } from '@shared/format'
import { FileGroupDialog, type FileGroupTarget } from '@/components/file-group-dialog'
import { GrowBar } from '@/components/size-bar'
import { ScrollArea } from '@/components/ui/scroll-area'
import { colorAt } from '@/lib/palette'
import { useScan } from '@/scan-context'

function groupOf(ext: string): FileGroupTarget {
  return { group: { by: 'ext', ext }, title: ext === '(none)' ? 'Files without an extension' : `${ext} files` }
}

export function ExtensionsView() {
  const { extensions } = useScan()
  const [listed, setListed] = useState<FileGroupTarget | null>(null)
  const max = extensions[0]?.size || 1
  return (
    <ScrollArea className="h-full">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-card text-left text-[11px] uppercase text-muted-foreground">
          <tr>
            <th className="px-3 py-2">Extension</th>
            <th className="px-3 py-2">Category</th>
            <th className="px-3 py-2 text-right">Files</th>
            <th className="px-3 py-2 text-right">Size</th>
            <th className="px-3 py-2">Share</th>
          </tr>
        </thead>
        <tbody>
          {extensions.map((row, i) => (
            <tr
              key={row.ext}
              tabIndex={0}
              title={`List ${row.ext === '(none)' ? 'files without an extension' : `${row.ext} files`}`}
              className="cursor-pointer border-t transition-colors duration-150 hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-none"
              onClick={() => setListed(groupOf(row.ext))}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                setListed(groupOf(row.ext))
              }}
            >
              <td className="px-3 py-1.5 font-medium">{row.ext}</td>
              <td className="px-3 py-1.5 text-muted-foreground">{row.category}</td>
              <td className="px-3 py-1.5 text-right tabular">{formatNumber(row.count)}</td>
              <td className="px-3 py-1.5 text-right tabular">{formatBytes(row.size)}</td>
              <td className="px-3 py-1.5">
                <div className="flex items-center gap-2">
                  <GrowBar ratio={row.size / max} color={colorAt(i)} className="h-2 flex-1" />
                  <span className="w-14 text-right text-xs tabular">{formatPercent(row.percent)}</span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {extensions.length === 0 ? (
        <p className="animate-fade p-6 text-sm text-muted-foreground">No file type data yet.</p>
      ) : null}
      <FileGroupDialog target={listed} onClose={() => setListed(null)} />
    </ScrollArea>
  )
}
