import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { parseDelimited, sniffDelimiter } from '../src/shared/csv'
import { ZipArchive, type ReadAt } from '../src/shared/zip'
import { previewKindOf, sniffMediaType } from '../src/shared/preview'

interface FixtureEntry {
  name: string
  data: string
  deflate?: boolean
  declaredSize?: number
}

// Builds a minimal ZIP archive with stored or deflated entries.
function buildZip(entries: FixtureEntry[]): Uint8Array {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const raw = Buffer.from(entry.data)
    const body = entry.deflate ? deflateRawSync(raw) : raw
    const size = entry.declaredSize ?? raw.length
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(entry.deflate ? 8 : 0, 8)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(entry.deflate ? 8 : 0, 10)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += 30 + name.length + body.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...locals, directory, end]))
}

function reader(bytes: Uint8Array): ReadAt {
  return async (offset, length) => bytes.slice(offset, offset + length)
}

describe('ZipArchive', () => {
  it('reads stored and deflated entries', async () => {
    const bytes = buildZip([
      { name: 'a.txt', data: 'stored text' },
      { name: 'word/document.xml', data: '<doc>'.repeat(200), deflate: true }
    ])
    const zip = await ZipArchive.open(reader(bytes), bytes.length)
    expect(zip.list()).toEqual([
      { name: 'a.txt', size: 11 },
      { name: 'word/document.xml', size: 1000 }
    ])
    expect(await zip.text('a.txt')).toBe('stored text')
    expect(await zip.text('word/document.xml')).toBe('<doc>'.repeat(200))
    expect(await zip.read('missing')).toBeNull()
  })

  it('stops entries that inflate past their declared size', async () => {
    const bytes = buildZip([{ name: 'bomb.xml', data: 'x'.repeat(100_000), deflate: true, declaredSize: 10 }])
    const zip = await ZipArchive.open(reader(bytes), bytes.length)
    await expect(zip.read('bomb.xml')).rejects.toThrow('larger than declared')
  })

  it('refuses entries above the size limit and non-archives', async () => {
    const bytes = buildZip([{ name: 'big.xml', data: 'y'.repeat(2048), deflate: true }])
    const zip = await ZipArchive.open(reader(bytes), bytes.length)
    await expect(zip.read('big.xml', 1024)).rejects.toThrow('too large')
    const text = new TextEncoder().encode('just some text that is not a zip archive')
    await expect(ZipArchive.open(reader(text), text.length)).rejects.toThrow('Not a ZIP archive')
    await expect(ZipArchive.open(reader(bytes.slice(0, 40)), bytes.length)).rejects.toThrow()
  })
})

describe('CSV parsing', () => {
  it('handles quotes, escaped quotes and CRLF', () => {
    const text = 'name,note\r\n"Smith, J","said ""hi"""\r\nplain,"multi\nline"\r\n'
    expect(parseDelimited(text, ',', 100)).toEqual({
      rows: [
        ['name', 'note'],
        ['Smith, J', 'said "hi"'],
        ['plain', 'multi\nline']
      ],
      complete: true
    })
  })

  it('stops at the row limit and drops a cut-off final row', () => {
    expect(parseDelimited('a\nb\nc\n', ',', 2)).toEqual({ rows: [['a'], ['b']], complete: false })
    expect(parseDelimited('a,b\nc,d\ne,', ',', 10, false)).toEqual({
      rows: [
        ['a', 'b'],
        ['c', 'd']
      ],
      complete: false
    })
  })

  it('detects the delimiter from the first line', () => {
    expect(sniffDelimiter('a;b;c\n1,2;3')).toBe(';')
    expect(sniffDelimiter('a\tb\tc')).toBe('\t')
    expect(sniffDelimiter('"x;y",b,c')).toBe(',')
  })
})

it('classifies files by preview type', () => {
  expect(previewKindOf('Movie.MP4')).toBe('video')
  expect(previewKindOf('report.pdf')).toBe('pdf')
  expect(previewKindOf('notes.docx')).toBe('docx')
  expect(previewKindOf('.gitignore')).toBe('text')
  expect(previewKindOf('README')).toBe('unknown')
})

it('serves media by its real container, not its extension', () => {
  const bytes = (...parts: Array<string | number[]>) =>
    Uint8Array.from(parts.flatMap((p) => (typeof p === 'string' ? [...Buffer.from(p, 'latin1')] : p)))
  // A DASH MP4 saved as .mp3 (common with downloaders).
  expect(sniffMediaType(bytes([0, 0, 0, 0x18], 'ftypdash'), 'audio/mpeg')).toBe('audio/mp4')
  expect(sniffMediaType(bytes([0, 0, 0, 0x20], 'ftypisom'), 'video/webm')).toBe('video/mp4')
  expect(sniffMediaType(bytes('OggS', [0, 2]), 'audio/mpeg')).toBe('audio/ogg')
  expect(sniffMediaType(bytes([0x1a, 0x45, 0xdf, 0xa3]), 'video/mp4')).toBe('video/webm')
  expect(sniffMediaType(bytes('RIFF', [0, 0, 0, 0], 'WAVE'), 'audio/mpeg')).toBe('audio/wav')
  expect(sniffMediaType(bytes('fLaC'), 'audio/mpeg')).toBe('audio/flac')
  expect(sniffMediaType(bytes('ID3', [4, 0]), 'audio/mp4')).toBe('audio/mpeg')
  expect(sniffMediaType(bytes([0xff, 0xfb, 0x90]), 'audio/mp4')).toBe('audio/mpeg')
  expect(sniffMediaType(bytes([0xff, 0xf1, 0x50]), 'audio/mpeg')).toBe('audio/aac')
  expect(sniffMediaType(bytes('garbage!'), 'audio/flac')).toBe('audio/flac')
  // Images keep their declared type.
  expect(sniffMediaType(bytes([0, 0, 0, 0x18], 'ftypavif'), 'image/avif')).toBe('image/avif')
})
