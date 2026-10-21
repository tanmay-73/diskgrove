// Minimal random-access ZIP reader for Office Open XML previews. It reads only
// the central directory and the entries a preview asks for, so large archives
// never have to be loaded whole. ZIP64 and encrypted archives are not supported.

export type ReadAt = (offset: number, length: number) => Promise<Uint8Array>

interface ZipEntry {
  method: number
  flags: number
  compressedSize: number
  size: number
  localOffset: number
}

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const EOCD_SIZE = 22
const MAX_COMMENT = 0xffff
const MAX_DIRECTORY = 16 * 1024 * 1024
const DEFAULT_MAX_ENTRY = 32 * 1024 * 1024

function u16(b: Uint8Array, i: number): number {
  return b[i] | (b[i + 1] << 8)
}

function u32(b: Uint8Array, i: number): number {
  return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0
}

async function readExact(readAt: ReadAt, offset: number, length: number): Promise<Uint8Array> {
  const bytes = await readAt(offset, length)
  if (bytes.length !== length) throw new Error('Archive is truncated')
  return bytes
}

async function inflateRaw(data: Uint8Array, limit: number): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(data as Uint8Array<ArrayBuffer>)
      controller.close()
    }
  })
  const reader = source.pipeThrough(new DecompressionStream('deflate-raw')).getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    // The declared size is untrusted; stop decompression bombs as soon as they overrun it.
    if (total > limit) {
      await reader.cancel()
      throw new Error('Archive entry is larger than declared')
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

export class ZipArchive {
  private constructor(
    private readonly readAt: ReadAt,
    private readonly entries: Map<string, ZipEntry>
  ) {}

  static async open(readAt: ReadAt, fileSize: number): Promise<ZipArchive> {
    if (fileSize < EOCD_SIZE) throw new Error('Not a ZIP archive')
    const tailLength = Math.min(fileSize, EOCD_SIZE + MAX_COMMENT)
    const tail = await readExact(readAt, fileSize - tailLength, tailLength)
    let eocd = -1
    for (let i = tail.length - EOCD_SIZE; i >= 0; i--) {
      if (u32(tail, i) === EOCD_SIGNATURE) {
        eocd = i
        break
      }
    }
    if (eocd < 0) throw new Error('Not a ZIP archive')

    const count = u16(tail, eocd + 10)
    const directorySize = u32(tail, eocd + 12)
    const directoryOffset = u32(tail, eocd + 16)
    if (count === 0xffff || directoryOffset === 0xffffffff) throw new Error('ZIP64 archives are not supported')
    if (directorySize > MAX_DIRECTORY || directoryOffset + directorySize > fileSize) {
      throw new Error('Archive directory is invalid')
    }

    const directory = await readExact(readAt, directoryOffset, directorySize)
    const decoder = new TextDecoder()
    const entries = new Map<string, ZipEntry>()
    let p = 0
    for (let i = 0; i < count && p + 46 <= directory.length; i++) {
      if (u32(directory, p) !== CENTRAL_SIGNATURE) break
      const nameLength = u16(directory, p + 28)
      const extraLength = u16(directory, p + 30)
      const commentLength = u16(directory, p + 32)
      const name = decoder.decode(directory.subarray(p + 46, p + 46 + nameLength))
      entries.set(name, {
        flags: u16(directory, p + 8),
        method: u16(directory, p + 10),
        compressedSize: u32(directory, p + 20),
        size: u32(directory, p + 24),
        localOffset: u32(directory, p + 42)
      })
      p += 46 + nameLength + extraLength + commentLength
    }
    return new ZipArchive(readAt, entries)
  }

  has(name: string): boolean {
    return this.entries.has(name)
  }

  list(): Array<{ name: string; size: number }> {
    return [...this.entries].map(([name, entry]) => ({ name, size: entry.size }))
  }

  async read(name: string, maxSize = DEFAULT_MAX_ENTRY): Promise<Uint8Array | null> {
    const entry = this.entries.get(name)
    if (!entry) return null
    if (entry.flags & 0x1) throw new Error('Encrypted archives cannot be previewed')
    if (entry.size > maxSize) throw new Error(`${name} is too large to preview`)
    const header = await readExact(this.readAt, entry.localOffset, 30)
    if (u32(header, 0) !== LOCAL_SIGNATURE) throw new Error('Archive entry is invalid')
    const dataOffset = entry.localOffset + 30 + u16(header, 26) + u16(header, 28)
    const data = await readExact(this.readAt, dataOffset, entry.compressedSize)
    if (entry.method === 0) return data
    if (entry.method === 8) return inflateRaw(data, entry.size)
    throw new Error('Unsupported compression method')
  }

  async text(name: string, maxSize?: number): Promise<string | null> {
    const bytes = await this.read(name, maxSize)
    return bytes ? new TextDecoder().decode(bytes) : null
  }
}
