import type { Stats } from 'node:fs'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Lets a test hold a paused walk until it has changed the scan.
const pause = vi.hoisted(() => ({ hold: null as Promise<void> | null }))
vi.mock('node:timers/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:timers/promises')>()
  return {
    ...actual,
    setImmediate: async () => {
      await pause.hold
      await actual.setImmediate()
    }
  }
})
vi.mock('electron', () => ({ shell: { trashItem: vi.fn() } }))
import { joinPath, NONE, ScanTree } from '../src/main/scan-tree'
import { Scanner } from '../src/main/scanner'

const stats = (n: number) =>
  ({ dev: 7, ino: 1000 + n, birthtimeMs: 1.5e12 + n, mode: 0o100644, size: n, mtimeMs: 1.6e12 + n }) as Stats

describe('scan tree', () => {
  it('rebuilds and finds paths below a folder and below a filesystem root', () => {
    for (const root of [path.resolve('scan-root'), path.parse(path.resolve('/')).root]) {
      const tree = new ScanTree(root)
      tree.add(root, 'dir', NONE, stats(0))
      const docs = tree.add('docs', 'dir', 0, stats(1))
      const file = tree.add('Report.TXT', 'file', docs, stats(2))
      const docsPath = path.join(root, 'docs')
      const filePath = path.join(docsPath, 'Report.TXT')
      expect(joinPath(root, 'docs')).toBe(docsPath)
      expect(tree.pathOf(file)).toBe(filePath)
      expect(tree.parentPath(file, filePath)).toBe(docsPath)
      expect(tree.parentPath(docs, docsPath)).toBe(root)
      expect(tree.parentPath(0, root)).toBeNull()
      expect(tree.find(root)).toBe(0)
      expect(tree.find(filePath)).toBe(file)
      expect(tree.find(docsPath + path.sep)).toBeNull()
      expect(tree.find(path.join(docsPath, 'report.txt'))).toBeNull()
      expect(tree.ext(file)).toBe('.txt')
      expect(tree.hasSubdirs(0)).toBe(true)
      expect(tree.hasSubdirs(docs)).toBe(false)
    }
  })

  it('keeps every column as it grows', () => {
    const tree = new ScanTree(path.resolve('scan-root'))
    tree.add('scan-root', 'dir', NONE, stats(0))
    for (let i = 1; i <= 5000; i++) tree.addToAncestors(tree.add(`f${i}.bin`, 'file', 0, stats(i)), i, i, 1, 0)
    expect(tree.count).toBe(5001)
    expect(tree.size[0]).toBe((5000 * 5001) / 2)
    expect(tree.fileCount[0]).toBe(5000)
    expect([...tree.children(0)]).toHaveLength(5000)
    const last = tree.find(path.join(tree.rootPath, 'f5000.bin'))!
    expect(tree.identity(last)).toEqual({
      dev: 7,
      ino: 6000,
      birthtimeMs: 1.5e12 + 5000,
      mode: 0o100644,
      size: 5000,
      mtimeMs: 1.6e12 + 5000
    })
  })

  it('takes a removed item out of its folder and the totals, keeping sibling order', () => {
    const tree = new ScanTree(path.resolve('scan-root'))
    tree.add('scan-root', 'dir', NONE, stats(0))
    const a = tree.add('a', 'file', 0, stats(1))
    tree.addToAncestors(a, 10, 10, 1, 0)
    const b = tree.add('b', 'dir', 0, stats(2))
    tree.addToAncestors(0, 0, 0, 0, 1)
    const inner = tree.add('inner', 'file', b, stats(3))
    tree.addToAncestors(inner, 5, 5, 1, 0)
    const c = tree.add('c', 'file', 0, stats(4))
    tree.addToAncestors(c, 1, 1, 1, 0)

    tree.remove(b)
    expect([...tree.children(0)]).toEqual([a, c])
    expect(tree.isRemoved(inner)).toBe(true)
    expect(tree.find(path.join(tree.rootPath, 'b', 'inner'))).toBeNull()
    expect([tree.size[0], tree.fileCount[0], tree.folderCount[0]]).toEqual([11, 2, 0])

    tree.remove(c)
    const d = tree.add('d', 'file', 0, stats(5))
    expect([...tree.children(0)]).toEqual([a, d])
  })
})

describe('whole-tree queries', () => {
  let fixture: string
  let root: string
  let scanner: Scanner

  beforeEach(async () => {
    fixture = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'diskgrove-tree-test-'))
    root = path.join(fixture, 'scan')
    await fs.mkdir(path.join(root, 'docs'), { recursive: true })
    await fs.writeFile(path.join(root, 'docs', 'big.bin'), Buffer.alloc(300))
    await fs.writeFile(path.join(root, 'docs', 'notes.TXT'), 'twenty bytes of text')
    await fs.writeFile(path.join(root, 'small.txt'), 'x')
    scanner = new Scanner()
    await scanner.start(root)
    Object.assign(scanner, { walkSlice: 1 })
  })

  afterEach(async () => {
    pause.hold = null
    if (
      path.dirname(fixture) !== (await fs.realpath(os.tmpdir())) ||
      !path.basename(fixture).startsWith('diskgrove-tree-test-')
    ) {
      throw new Error('Unexpected fixture path')
    }
    await fs.rm(fixture, { recursive: true, force: true })
  })

  it('lets other work run between slices', async () => {
    let ran = false
    setImmediate(() => {
      ran = true
    })
    const top = await scanner.getTopFiles(root, 10)
    expect(ran).toBe(true)
    expect(top.map((n) => n.name)).toEqual(['big.bin', 'notes.TXT', 'small.txt'])
    expect(top[0].path).toBe(path.join(root, 'docs', 'big.bin'))
    expect(top[0].parentPath).toBe(path.join(root, 'docs'))
    expect((await scanner.getExtensions(root)).map((e) => [e.ext, e.count, e.size])).toEqual([
      ['.bin', 1, 300],
      ['.txt', 2, 21]
    ])
    expect((await scanner.getAgeStats(root))[0]).toMatchObject({ id: '1d', count: 3, size: 321 })
  })

  it('lists the files of one extension or age bucket, largest first', async () => {
    const txt = await scanner.getGroupFiles({ by: 'ext', ext: '.txt' }, root, 10)
    expect(txt.root).toBe(root)
    expect(txt.total).toBe(2)
    expect(txt.hits.map((n) => n.name)).toEqual(['notes.TXT', 'small.txt'])
    const docs = await scanner.getGroupFiles({ by: 'ext', ext: '.txt' }, path.join(root, 'docs'), 10)
    expect(docs.hits.map((n) => n.name)).toEqual(['notes.TXT'])
    const recent = await scanner.getGroupFiles({ by: 'age', id: '1d' }, root, 2)
    expect(recent.total).toBe(3)
    expect(recent.hits.map((n) => n.name)).toEqual(['big.bin', 'notes.TXT'])
    await fs.utimes(path.join(root, 'small.txt'), new Date('2015-01-01'), new Date('2015-01-01'))
    await scanner.start(root)
    expect((await scanner.getGroupFiles({ by: 'age', id: 'old' }, root, 10)).hits.map((n) => n.name)).toEqual([
      'small.txt'
    ])
    expect((await scanner.getGroupFiles({ by: 'ext', ext: '.mp4' }, root, 10)).total).toBe(0)
    expect((await scanner.getGroupFiles({ by: 'age', id: 'nope' }, root, 10)).total).toBe(0)
  })

  it('leaves out items deleted while a query was paused', async () => {
    let release!: () => void
    pause.hold = new Promise<void>((resolve) => (release = resolve))
    const top = scanner.getTopFiles(root, 10)
    const extensions = scanner.getExtensions(root)
    expect((await scanner.deletePath(path.join(root, 'docs'), 'permanent')).ok).toBe(true)
    release()
    expect((await top).map((n) => n.name)).toEqual(['small.txt'])
    expect((await extensions).map((e) => [e.ext, e.count, e.size])).toEqual([['.txt', 1, 1]])
  })

  it('drops a query when a rescan replaces the results it was reading', async () => {
    const pending = scanner.getExtensions(root)
    const rescan = scanner.start(root)
    expect(await pending).toEqual([])
    await rescan
    expect(await scanner.getExtensions(null)).toHaveLength(2)
  })

  it('exports every remaining item with its path, folders before their contents', async () => {
    await scanner.deletePath(path.join(root, 'docs', 'big.bin'), 'permanent')
    const rows = scanner.flatten().map((n) => [n.path, n.parentPath])
    // Siblings are listed in the order their stats came back.
    expect([...rows].sort()).toEqual([
      [root, null],
      [path.join(root, 'docs'), root],
      [path.join(root, 'docs', 'notes.TXT'), path.join(root, 'docs')],
      [path.join(root, 'small.txt'), root]
    ])
    const position = (p: string) => rows.findIndex(([item]) => item === p)
    expect(position(root)).toBe(0)
    expect(position(path.join(root, 'docs'))).toBeLessThan(position(path.join(root, 'docs', 'notes.TXT')))
  })
})
