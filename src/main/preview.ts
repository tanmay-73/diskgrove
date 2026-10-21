import { Readable } from 'node:stream'
import { MAX_PREVIEW_READ, MEDIA_SNIFF_BYTES, mediaTypeOf, sniffMediaType } from '@shared/preview'
import type { FileChunk, ItemTimes } from '@shared/types'
import { createReadStream, fs } from './real-fs'

const RANGE = /^bytes=(\d*)-(\d*)$/

async function regularFileSize(target: string): Promise<number> {
  // stat before opening: opening a FIFO or device for reading can block indefinitely.
  // It follows a link, which the identity check only lets through when the scan followed it too.
  const stats = await fs.stat(target)
  if (!stats.isFile()) throw new Error('Only regular files can be previewed')
  return stats.size
}

export async function readChunk(target: string, offset: number, length: number): Promise<FileChunk> {
  await regularFileSize(target)
  const handle = await fs.open(target, 'r')
  try {
    const stats = await handle.stat()
    if (!stats.isFile()) throw new Error('Only regular files can be previewed')
    const start = Math.min(Math.max(0, offset), stats.size)
    const want = Math.max(0, Math.min(length, MAX_PREVIEW_READ, stats.size - start))
    const buffer = Buffer.alloc(want)
    let read = 0
    while (read < want) {
      const { bytesRead } = await handle.read(buffer, read, want - read, start + read)
      if (bytesRead === 0) break
      read += bytesRead
    }
    return { bytes: new Uint8Array(buffer.buffer, buffer.byteOffset, read), offset: start, size: stats.size }
  } finally {
    await handle.close()
  }
}

export async function itemTimes(target: string): Promise<ItemTimes> {
  const stats = await fs.lstat(target)
  return { created: stats.birthtimeMs, modified: stats.mtimeMs, accessed: stats.atimeMs }
}

async function readHead(target: string, length: number): Promise<Uint8Array> {
  const handle = await fs.open(target, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

function emptyResponse(status: number, headers?: Record<string, string>): Response {
  return new Response(null, { status, headers })
}

// Serves one media file with HTTP range support so <video> and <audio> can seek.
export async function mediaResponse(target: string, name: string, range: string | null): Promise<Response> {
  const declared = mediaTypeOf(name)
  if (!declared) return emptyResponse(415)
  const size = await regularFileSize(target)
  const type = sniffMediaType(await readHead(target, MEDIA_SNIFF_BYTES), declared)

  let start = 0
  let end = size - 1
  let partial = false
  if (range) {
    const match = RANGE.exec(range.trim())
    if (!match || (match[1] === '' && match[2] === '')) {
      return emptyResponse(416, { 'Content-Range': `bytes */${size}` })
    }
    if (match[1] === '') {
      start = Math.max(0, size - Number(match[2]))
    } else {
      start = Number(match[1])
      if (match[2] !== '') end = Math.min(Number(match[2]), size - 1)
    }
    if (start >= size || start > end) return emptyResponse(416, { 'Content-Range': `bytes */${size}` })
    partial = true
  }

  const headers: Record<string, string> = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'"
  }
  if (size === 0) return new Response(null, { status: 200, headers: { ...headers, 'Content-Length': '0' } })
  headers['Content-Length'] = String(end - start + 1)
  if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${size}`

  const body = Readable.toWeb(createReadStream(target, { start, end })) as ReadableStream<Uint8Array>
  return new Response(body, { status: partial ? 206 : 200, headers })
}
