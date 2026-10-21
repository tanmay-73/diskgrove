import { useEffect, useRef, useState } from 'react'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { formatNumber } from '@shared/format'
import { Button } from '@/components/ui/button'
import { fileReader } from '@/lib/file-reader'
import { openPdf } from '@/lib/pdf'
import { errorMessage, IconPreview, Loading, type InfoRow, type ViewerProps } from './viewers'

function pdfDetails(pdf: PDFDocumentProxy, info: Record<string, unknown>, width: number, height: number): InfoRow[] {
  const text = (key: string) => (typeof info[key] === 'string' ? (info[key] as string).trim() : '')
  const rows: InfoRow[] = [
    ['Pages', formatNumber(pdf.numPages)],
    ['Resolution', `${Math.round(width)} × ${Math.round(height)}`]
  ]
  const add = (label: string, value: string) => value && rows.push([label, value])
  add('Version', text('PDFFormatVersion'))
  add('Title', text('Title'))
  add('Authors', text('Author'))
  add('Content creator', text('Creator'))
  add('Encoding software', text('Producer'))
  rows.push(['Security', info.EncryptFilterName ? 'Encrypted' : 'None'])
  return rows
}

export function PdfViewer({ item, onDetails }: ViewerProps) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [box, setBox] = useState({ width: 0, height: 0 })
  const boxRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let live = true
    let task: PDFDocumentLoadingTask | null = null
    setPdf(null)
    setError(null)
    setPage(1)
    void (async () => {
      task = await openPdf(fileReader(item.path), item.size)
      if (!live) return
      const doc = await task.promise
      if (!live) return
      setPdf(doc)
      const [meta, first] = await Promise.all([doc.getMetadata().catch(() => null), doc.getPage(1)])
      const viewport = first.getViewport({ scale: 1 })
      if (live)
        onDetails(pdfDetails(doc, (meta?.info ?? {}) as Record<string, unknown>, viewport.width, viewport.height))
    })().catch((err: unknown) => {
      if (!live) return
      const name = err instanceof Error ? err.name : ''
      setError(
        name === 'PasswordException'
          ? 'This PDF is password protected.'
          : errorMessage(err, 'This PDF could not be read.')
      )
    })
    return () => {
      live = false
      void task?.destroy()
    }
  }, [item.path, item.size, item.mtime, onDetails])

  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setBox((prev) =>
        Math.abs(prev.width - width) < 2 && Math.abs(prev.height - height) < 2 ? prev : { width, height }
      )
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [pdf])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!pdf || !canvas || box.width === 0 || box.height === 0) return
    let live = true
    let render: RenderTask | null = null
    void (async () => {
      const pdfPage = await pdf.getPage(page)
      if (!live) return
      const base = pdfPage.getViewport({ scale: 1 })
      const fit = Math.min(box.width / base.width, box.height / base.height)
      const ratio = window.devicePixelRatio || 1
      const viewport = pdfPage.getViewport({ scale: fit * ratio })
      canvas.width = Math.max(1, Math.floor(viewport.width))
      canvas.height = Math.max(1, Math.floor(viewport.height))
      canvas.style.width = `${Math.floor(viewport.width / ratio)}px`
      canvas.style.height = `${Math.floor(viewport.height / ratio)}px`
      render = pdfPage.render({ canvas, viewport })
      await render.promise
    })().catch(() => undefined)
    return () => {
      live = false
      render?.cancel()
    }
  }, [pdf, page, box])

  if (error) return <IconPreview item={item} message={error} />
  if (!pdf) return <Loading />
  const pages = pdf.numPages
  return (
    <div className="relative flex h-full flex-col">
      <div ref={boxRef} className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        <canvas ref={canvasRef} className="rounded-sm bg-white shadow-md animate-fade" />
      </div>
      {pages > 1 ? (
        <div className="absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border bg-card/90 px-1 py-0.5 text-xs shadow-md backdrop-blur">
          <Button
            variant="ghost"
            size="icon"
            className="size-6 rounded-full"
            aria-label="Previous page"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <ChevronLeft />
          </Button>
          <span className="min-w-14 text-center tabular">
            {formatNumber(page)} / {formatNumber(pages)}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 rounded-full"
            aria-label="Next page"
            disabled={page >= pages}
            onClick={() => setPage((p) => Math.min(pages, p + 1))}
          >
            <ChevronRight />
          </Button>
        </div>
      ) : null}
    </div>
  )
}
