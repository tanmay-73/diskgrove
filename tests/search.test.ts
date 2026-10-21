import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ shell: { trashItem: vi.fn() } }))
import { compileNameQuery, foldName, wildcardMatch } from '../src/main/name-match'
import { Scanner } from '../src/main/scanner'
import { baseName, isWithin, pathCrumbs } from '../src/shared/paths'

describe('name queries', () => {
  const matches = (query: string, name: string) => compileNameQuery(query)!(name)

  it('matches plain text anywhere in the name, ignoring case', () => {
    expect(matches('REPORT', 'Quarterly report.pdf')).toBe(true)
    expect(matches('  report ', 'report.txt')).toBe(true)
    expect(matches('reports', 'report.txt')).toBe(false)
  })

  it('requires wildcard patterns to match the whole name', () => {
    expect(matches('*.mp4', 'clip.MP4')).toBe(true)
    expect(matches('*.mp4', 'clip.mp4.part')).toBe(false)
    expect(matches('clip*', 'my clip.mp4')).toBe(false)
    expect(matches('r*?.txt', 'report.txt')).toBe(true)
    expect(matches('r*?.txt', 'r.txt')).toBe(false)
    expect(matches('file-??.log', 'file-07.log')).toBe(true)
    expect(matches('file-??.log', 'file-7.log')).toBe(false)
  })

  it('treats composed and decomposed spellings as the same name', () => {
    const decomposed = 'cafe\u0301-menu.txt'
    const composed = 'caf\u00e9-menu.txt'
    expect(matches('caf\u00e9', decomposed)).toBe(true)
    expect(matches('cafe\u0301', composed)).toBe(true)
    expect(matches('CAF\u00c9*', decomposed)).toBe(true)
    expect(foldName('\u00c5ngstr\u00f6m')).toBe(foldName('A\u030angstro\u0308m'))
  })

  it('lets ? stand for one whole character, including emoji', () => {
    expect(matches('? party.png', '\u{1F389} party.png')).toBe(true)
    expect(matches('?? party.png', '\u{1F389} party.png')).toBe(false)
    expect(matches('*\u{1F389}*', 'big \u{1F389} night')).toBe(true)
  })

  it('still treats * as a wildcard when the name contains a literal *', () => {
    expect(wildcardMatch('*a.txt', '*.txt')).toBe(true)
    expect(wildcardMatch('a*b', 'a?b')).toBe(true)
  })

  it('ignores empty queries and caps long ones', () => {
    expect(compileNameQuery('')).toBeNull()
    expect(compileNameQuery('   ')).toBeNull()
    const long = 'a'.repeat(300)
    expect(matches(long, 'a'.repeat(256))).toBe(true)
  })

  it('stays fast on patterns built to backtrack', () => {
    const started = performance.now()
    expect(wildcardMatch('a'.repeat(5000), `${'*a'.repeat(100)}b`)).toBe(false)
    expect(performance.now() - started).toBeLessThan(1000)
  })
})

describe('scan search', () => {
  let fixture: string
  let root: string
  let scanner: Scanner

  const write = async (rel: string, size: number) => {
    const p = path.join(root, ...rel.split('/'))
    await fs.mkdir(path.dirname(p), { recursive: true })
    await fs.writeFile(p, Buffer.alloc(size, 1))
  }

  beforeEach(async () => {
    fixture = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'diskgrove-search-test-'))
    root = path.join(fixture, 'scan')
    await write('docs/report-a.txt', 30)
    await write('docs/report-b.txt', 10)
    await write('docs/nested/report-c.txt', 20)
    await write('docs/report/notes.txt', 5)
    await write('other/report-d.txt', 40)
    await write('cafe\u0301.txt', 1)
    scanner = new Scanner()
    await scanner.start(root)
  })

  afterEach(async () => {
    if (
      path.dirname(fixture) !== (await fs.realpath(os.tmpdir())) ||
      !path.basename(fixture).startsWith('diskgrove-search-test-')
    ) {
      throw new Error('Unexpected fixture path')
    }
    await fs.rm(fixture, { recursive: true, force: true })
  })

  it('searches the whole scan when no folder is given', async () => {
    const result = await scanner.search('report', null, 100)
    expect(result.root).toBe(root)
    expect(result.total).toBe(5)
    expect(result.hits.map((n) => n.name)).toEqual([
      'report-d.txt',
      'report-a.txt',
      'report-c.txt',
      'report-b.txt',
      'report'
    ])
  })

  it('searches only below the selected folder and never returns the folder itself', async () => {
    const docs = path.join(root, 'docs')
    const result = await scanner.search('*', docs, 100)
    expect(result.root).toBe(docs)
    expect(result.hits.map((n) => n.path)).not.toContain(docs)
    expect(result.hits.every((n) => isWithin(docs, n.path))).toBe(true)
    expect(result.total).toBe(6)

    const reports = await scanner.search('report', docs, 100)
    expect(reports.hits.map((n) => n.name).sort()).toEqual(['report', 'report-a.txt', 'report-b.txt', 'report-c.txt'])
    expect((await scanner.search('docs', docs, 100)).total).toBe(0)
  })

  it('returns the largest matches and counts the rest', async () => {
    const result = await scanner.search('*.txt', null, 2)
    expect(result.total).toBe(6)
    expect(result.hits.map((n) => n.name)).toEqual(['report-d.txt', 'report-a.txt'])
  })

  it('finds decomposed names with a composed query', async () => {
    const result = await scanner.search('caf\u00e9', null, 10)
    expect(result.hits.map((n) => n.name.normalize('NFC'))).toEqual(['caf\u00e9.txt'])
  })

  it('returns nothing for folders outside the scan and for empty queries', async () => {
    expect(await scanner.search('report', path.join(fixture, 'elsewhere'), 10)).toMatchObject({ hits: [], total: 0 })
    expect(await scanner.search('   ', null, 10)).toMatchObject({ root, hits: [], total: 0 })
  })

  it('abandons a search once a newer one starts', async () => {
    Object.assign(scanner, { walkSlice: 1 })
    const first = scanner.search('report', null, 10)
    const second = scanner.search('notes', null, 10)
    expect(await first).toMatchObject({ hits: [], total: 0 })
    expect((await second).hits.map((n) => n.name)).toEqual(['notes.txt'])
  })

  it('drops a search when a rescan replaces the results it was reading', async () => {
    Object.assign(scanner, { walkSlice: 1 })
    const pending = scanner.search('report', null, 10)
    const rescan = scanner.start(root)
    expect(await pending).toMatchObject({ hits: [], total: 0 })
    await rescan
    expect((await scanner.search('report', null, 10)).total).toBe(5)
  })

  it('reflects deletions in later searches', async () => {
    await scanner.deletePath(path.join(root, 'other'), 'permanent')
    const result = await scanner.search('report', null, 10)
    expect(result.hits.map((n) => n.name)).not.toContain('report-d.txt')
    expect(result.total).toBe(4)
  })
})

describe('path helpers', () => {
  it('builds crumbs below Windows drive roots, folders and shares', () => {
    expect(pathCrumbs('C:\\', 'C:\\Users\\me').map((c) => c.path)).toEqual(['C:\\', 'C:\\Users', 'C:\\Users\\me'])
    expect(pathCrumbs('C:\\Users', 'C:\\Users\\me\\Documents').map((c) => c.label)).toEqual([
      'C:\\Users',
      'me',
      'Documents'
    ])
    expect(pathCrumbs('\\\\server\\share', '\\\\server\\share\\a').map((c) => c.path)).toEqual([
      '\\\\server\\share',
      '\\\\server\\share\\a'
    ])
  })

  it('builds crumbs for POSIX paths and keeps backslashes inside names', () => {
    expect(pathCrumbs('/', '/home/me').map((c) => c.path)).toEqual(['/', '/home', '/home/me'])
    expect(pathCrumbs('/data', '/data/a\\b/c').map((c) => c.label)).toEqual(['/data', 'a\\b', 'c'])
  })

  it('does not treat a sibling with a shared prefix as inside the root', () => {
    expect(isWithin('C:\\Users', 'C:\\Users2\\me')).toBe(false)
    expect(isWithin('/home/me', '/home/media')).toBe(false)
    expect(isWithin('/', '/home')).toBe(true)
    expect(isWithin('C:\\', 'C:\\Windows')).toBe(true)
    expect(pathCrumbs('/home/me', '/home/media/x')).toEqual([{ label: '/home/me', path: '/home/me' }])
  })

  it('names the last segment and keeps roots whole', () => {
    expect(baseName('C:\\Users\\me')).toBe('me')
    expect(baseName('C:\\')).toBe('C:\\')
    expect(baseName('/')).toBe('/')
    expect(baseName('/home/me/')).toBe('me')
    expect(baseName('/data/a\\b')).toBe('a\\b')
    expect(baseName('\\\\server\\share')).toBe('share')
  })
})
