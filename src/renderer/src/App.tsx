import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Loader2, Trash2 } from 'lucide-react'
import { formatBytes, formatNumber } from '@shared/format'
import type { DeleteMode } from '@shared/types'
import { TitleBar } from '@/components/title-bar'
import { Ribbon } from '@/components/ribbon'
import { StartScreen } from '@/components/start-screen'
import { DirectoryTree } from '@/components/directory-tree'
import { DetailsTable } from '@/components/details-table'
import { StatusBar } from '@/components/status-bar'
import { Breadcrumbs } from '@/components/breadcrumbs'
import { TreemapView } from '@/components/charts/treemap'
import { PieView } from '@/components/charts/pie-view'
import { BarView } from '@/components/charts/bar-view'
import { ExtensionsView } from '@/components/views/extensions-view'
import { TopFilesView } from '@/components/views/top-files-view'
import { AgeView } from '@/components/views/age-view'
import { DuplicatesView } from '@/components/views/duplicates-view'
import { SearchView } from '@/components/views/search-view'
import { FileGlyph } from '@/components/file-icon'
import { PreviewPane } from '@/components/preview/preview-pane'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { ScrollArea } from '@/components/ui/scroll-area'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ScanProvider, useScan } from '@/scan-context'
import { cn } from '@/lib/utils'

function RightPane() {
  const { tab } = useScan()
  let pane: ReactNode
  switch (tab) {
    case 'treemap':
      pane = <TreemapView />
      break
    case 'pie':
      pane = <PieView />
      break
    case 'bar':
      pane = <BarView />
      break
    case 'extensions':
      pane = <ExtensionsView />
      break
    case 'topfiles':
      pane = <TopFilesView />
      break
    case 'age':
      pane = <AgeView />
      break
    case 'duplicates':
      pane = <DuplicatesView />
      break
    case 'search':
      pane = <SearchView />
      break
    default:
      pane = <DetailsTable />
  }
  return (
    <div key={tab} className="h-full min-h-0 min-w-0 overflow-hidden animate-pane">
      {pane}
    </div>
  )
}

const DIALOG_LIST_LIMIT = 8

function DeleteDialog() {
  const { meta, pendingDelete, setPendingDelete, confirmDelete } = useScan()
  const [busy, setBusy] = useState(false)
  // The dialog opens from a list, not a trigger button, so it hands focus back to that list itself.
  const returnFocus = useRef<HTMLElement | null>(null)
  const items = pendingDelete ?? []
  const count = items.length
  const trashName = meta?.platform === 'win32' ? 'Recycle Bin' : 'Trash'
  const totalBytes = items.reduce((sum, item) => sum + item.size, 0)
  const title =
    count > 1 ? `Delete ${formatNumber(count)} items?` : items[0]?.kind === 'dir' ? 'Delete folder?' : 'Delete file?'

  const run = async (mode: DeleteMode) => {
    setBusy(true)
    try {
      await confirmDelete(mode)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={count > 0} onOpenChange={(open) => !open && !busy && setPendingDelete(null)}>
      <DialogContent
        className="max-w-lg"
        onOpenAutoFocus={() => {
          returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
        }}
        onCloseAutoFocus={(event) => {
          const target = returnFocus.current
          returnFocus.current = null
          if (!target?.isConnected || target === document.body) return
          event.preventDefault()
          target.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Move {count > 1 ? 'them' : 'it'} to the {trashName} to keep {count > 1 ? 'them' : 'it'} recoverable, or
            delete permanently. Permanent deletion cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md border bg-muted/30 text-xs">
          <ScrollArea orientation="vertical" className="max-h-44">
            <ul className="space-y-1 p-2">
              {items.slice(0, DIALOG_LIST_LIMIT).map((item) => (
                <li key={item.path} className="flex min-w-0 items-center gap-2" title={item.path}>
                  <FileGlyph name={item.name} kind={item.kind} />
                  <span className="min-w-0 flex-1 truncate">{item.path}</span>
                  <span className="shrink-0 tabular text-muted-foreground">{formatBytes(item.size)}</span>
                </li>
              ))}
              {count > DIALOG_LIST_LIMIT ? (
                <li className="text-muted-foreground">…and {formatNumber(count - DIALOG_LIST_LIMIT)} more</li>
              ) : null}
            </ul>
          </ScrollArea>
          <div className="border-t px-2 py-1.5 text-muted-foreground">
            {formatNumber(count)} item{count === 1 ? '' : 's'} · {formatBytes(totalBytes)}
          </div>
        </div>
        <DialogFooter className="flex-wrap">
          <Button variant="outline" disabled={busy} onClick={() => setPendingDelete(null)}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void run('trash')}>
            {busy ? <Loader2 className="animate-spin" /> : <Trash2 />} Move to {trashName}
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => void run('permanent')}>
            Delete permanently
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ToastHost() {
  const { toast } = useScan()
  const [message, setMessage] = useState<string | null>(null)
  const [leaving, setLeaving] = useState(false)
  const shown = useRef<string | null>(null)

  useEffect(() => {
    if (toast) {
      shown.current = toast
      setMessage(toast)
      setLeaving(false)
      return
    }
    if (!shown.current) return
    setLeaving(true)
    const id = window.setTimeout(() => {
      shown.current = null
      setMessage(null)
      setLeaving(false)
    }, 180)
    return () => window.clearTimeout(id)
  }, [toast])

  if (!message) return null
  return (
    <div
      className={cn(
        'pointer-events-none absolute bottom-10 right-4 z-50 rounded-md border bg-card px-3 py-2 text-sm shadow-lg',
        leaving ? 'animate-toast-out' : 'animate-toast-in'
      )}
    >
      {message}
    </div>
  )
}

function Shell() {
  const { meta, view, scanning, cancelScan, rootPath, startScan, goHome, settings, focusSearch } = useScan()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const command = meta?.platform === 'darwin' ? e.metaKey : e.ctrlKey
      if (command && !e.altKey && e.key.toLowerCase() === 'f' && view === 'scan') {
        e.preventDefault()
        focusSearch()
        return
      }
      if (e.key === 'Escape' && scanning) void cancelScan()
      if (e.key === 'F5' && rootPath) {
        e.preventDefault()
        void startScan(rootPath)
      }
      if (e.key === 'F2') goHome()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [meta, view, scanning, cancelScan, rootPath, startScan, goHome, focusSearch])

  return (
    <div className="relative flex h-full min-h-0 w-full flex-1 flex-col">
      <TitleBar />
      <Ribbon />
      {view === 'start' ? (
        <StartScreen />
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden animate-pane">
          <Breadcrumbs />
          <div className="min-h-0 min-w-0 flex-1">
            <ResizablePanelGroup direction="horizontal">
              <ResizablePanel
                id="tree"
                order={1}
                defaultSize={settings.showPreview ? 22 : 30}
                minSize={14}
                maxSize={50}
                className="min-h-0 min-w-0"
              >
                <DirectoryTree />
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel
                id="main"
                order={2}
                defaultSize={settings.showPreview ? 50 : 70}
                minSize={30}
                className="min-h-0 min-w-0"
              >
                <div className="h-full min-h-0 min-w-0 overflow-hidden">
                  <RightPane />
                </div>
              </ResizablePanel>
              {settings.showPreview ? (
                <>
                  <ResizableHandle withHandle />
                  <ResizablePanel
                    id="preview"
                    order={3}
                    defaultSize={28}
                    minSize={18}
                    maxSize={50}
                    className="min-h-0 min-w-0"
                  >
                    <PreviewPane />
                  </ResizablePanel>
                </>
              ) : null}
            </ResizablePanelGroup>
          </div>
        </div>
      )}
      <StatusBar />
      <DeleteDialog />
      <ToastHost />
    </div>
  )
}

export default function App() {
  return (
    <TooltipProvider delayDuration={250}>
      <ScanProvider>
        <Shell />
      </ScanProvider>
    </TooltipProvider>
  )
}
