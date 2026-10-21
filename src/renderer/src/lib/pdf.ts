import type { PDFDocumentLoadingTask } from 'pdfjs-dist'
import type { ReadAt } from '@shared/zip'

type PdfJs = typeof import('pdfjs-dist')

// Files up to this size are read in one go; larger ones are fetched in ranges on demand.
const WHOLE_FILE_LIMIT = 4 * 1024 * 1024
const INITIAL_CHUNK = 256 * 1024

let pdfjs: Promise<PdfJs> | null = null

// pdf.js is loaded on first use so it stays out of the startup bundle.
function loadPdfJs(): Promise<PdfJs> {
  pdfjs ??= Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]).then(
    ([lib, worker]) => {
      lib.GlobalWorkerOptions.workerSrc = worker.default
      return lib
    }
  )
  return pdfjs
}

export async function openPdf(readAt: ReadAt, size: number): Promise<PDFDocumentLoadingTask> {
  const lib = await loadPdfJs()
  const options = { disableAutoFetch: true, disableStream: true, enableXfa: false }
  if (size <= WHOLE_FILE_LIMIT) return lib.getDocument({ ...options, data: await readAt(0, size) })

  const initial = await readAt(0, Math.min(size, INITIAL_CHUNK))
  let task: PDFDocumentLoadingTask | null = null
  class Transport extends lib.PDFDataRangeTransport {
    requestDataRange(begin: number, end: number) {
      readAt(begin, end - begin).then(
        (bytes) => this.onDataRange(begin, bytes),
        () => void task?.destroy()
      )
    }
  }
  task = lib.getDocument({ ...options, range: new Transport(size, initial) })
  return task
}
