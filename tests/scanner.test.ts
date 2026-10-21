import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ shell: { trashItem: vi.fn() } }))
import { resolveScanRoot, Scanner } from '../src/main/scanner'

let fixture: string
let root: string
let scanner: Scanner

beforeEach(async () => {
  fixture = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'diskgrove-test-'))
  root = path.join(fixture, 'scan')
  await fs.mkdir(root)
  scanner = new Scanner()
})

afterEach(async () => {
  vi.restoreAllMocks()
  if (
    path.dirname(fixture) !== (await fs.realpath(os.tmpdir())) ||
    !path.basename(fixture).startsWith('diskgrove-test-')
  ) {
    throw new Error('Unexpected fixture path')
  }
  await fs.rm(fixture, { recursive: true, force: true })
})

describe('scan snapshots', () => {
  it('cancels directory iteration and can rescan afterward', async () => {
    await Promise.all(Array.from({ length: 200 }, (_, i) => fs.writeFile(path.join(root, `file-${i}.txt`), 'x')))
    const lstat = fs.lstat.bind(fs)
    let reads = 0
    const spy = vi.spyOn(fs, 'lstat').mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
      if (String(args[0]).endsWith('.txt') && ++reads === 50) scanner.cancel()
      return lstat(...args)
    })
    await scanner.start(root)
    expect(scanner.isRunning).toBe(false)
    const partial = scanner.finish({ total: 0, free: 0 })
    expect(partial.files).toBeLessThan(200)
    expect(partial.cancelled).toBe(true)
    spy.mockRestore()
    await scanner.start(root)
    const full = scanner.finish({ total: 0, free: 0 })
    expect(full.files).toBe(200)
    expect(full.cancelled).toBe(false)
  })

  it('does not mark a finished scan as stopped when the cancel arrives late', async () => {
    await fs.writeFile(path.join(root, 'report.txt'), 'hello')
    await scanner.start(root)
    scanner.cancel()
    expect(scanner.finish({ total: 0, free: 0 }).cancelled).toBe(false)
  })

  it('counts files, skips hidden entries on request, and searches with globs', async () => {
    await fs.writeFile(path.join(root, 'report.txt'), 'hello')
    await fs.writeFile(path.join(root, '.hidden'), 'hidden')
    await scanner.start(root, { skipHidden: true })
    expect(scanner.finish({ total: 0, free: 0 }).bytes).toBe(5)
    expect((await scanner.search('r*?.txt', root, 10)).hits.map((n) => n.name)).toEqual(['report.txt'])
  })

  it.runIf(process.platform === 'win32')('starts a scan at a drive root', async () => {
    const driveRoot = path.parse(fixture).root
    scanner.onProgress = () => scanner.cancel()
    await scanner.start(driveRoot)
    expect(scanner.finish({ total: 0, free: 0 }).rootPath).toBe(driveRoot)
  })

  it('rejects missing roots and clears its running state', async () => {
    await expect(scanner.start(path.join(root, 'missing'))).rejects.toThrow()
    expect(scanner.isRunning).toBe(false)
  })

  it('keeps case-distinct paths separate when supported by the filesystem', async (context) => {
    const upper = path.join(root, 'Report')
    const lower = path.join(root, 'report')
    await fs.writeFile(upper, 'A')
    try {
      await fs.writeFile(lower, 'BBBB', { flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return context.skip()
      throw error
    }
    await scanner.start(root)
    expect(scanner.getNode(upper)?.size).toBe(1)
    expect(scanner.getNode(lower)?.size).toBe(4)
  })

  it('follows directory links without recursing through cycles', async () => {
    const outside = path.join(fixture, 'outside')
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'file.txt'), 'content')
    await fs.symlink(outside, path.join(root, 'linked'), 'junction')
    await fs.symlink(root, path.join(outside, 'loop'), 'junction')
    await scanner.start(root)
    expect(scanner.getNode(path.join(root, 'linked'))).toBeNull()
    await scanner.start(root, { followLinks: true })
    expect(scanner.getNode(path.join(root, 'linked', 'file.txt'))?.size).toBe(7)
    expect(scanner.flatten()).toHaveLength(4)
  })

  it.runIf(process.platform !== 'win32')('reports no allocation for blocks a sparse file never wrote', async () => {
    const sparse = path.join(root, 'sparse.bin')
    await fs.writeFile(sparse, '')
    await fs.truncate(sparse, 1024 * 1024)
    await scanner.start(root)
    expect(scanner.getNode(sparse)?.size).toBe(1024 * 1024)
    expect(scanner.getNode(sparse)?.allocated).toBe((await fs.stat(sparse)).blocks * 512)
  })

  it.runIf(process.platform === 'linux')('lists kernel virtual filesystems without scanning them', async () => {
    await fs.writeFile(path.join(root, 'real.txt'), 'data')
    await fs.symlink('/proc', path.join(root, 'proc'))
    await scanner.start(root, { followLinks: true })
    expect(scanner.getNode(path.join(root, 'proc'))).toMatchObject({ kind: 'dir', size: 0, fileCount: 0 })
    expect(scanner.getNode(path.join(root, 'proc', 'version'))).toBeNull()
    expect(scanner.finish({ total: 0, free: 0 })).toMatchObject({ files: 1, bytes: 4 })
  })

  it.runIf(process.platform === 'linux')('scans a virtual filesystem chosen as the root', async () => {
    await scanner.start('/proc/sys/kernel')
    expect(scanner.getNode('/proc/sys/kernel/ostype')?.kind).toBe('file')
  })
})

describe('file actions', () => {
  it('refuses roots and items outside the scan', async () => {
    await scanner.start(root)
    expect((await scanner.deletePath(root, 'permanent')).ok).toBe(false)
    expect((await scanner.deletePath(fixture, 'permanent')).ok).toBe(false)
  })

  it('refuses a file replaced after the scan, even if its type is unchanged', async () => {
    const target = path.join(root, 'file.txt')
    await fs.writeFile(target, 'old')
    await scanner.start(root)
    await fs.rename(target, path.join(root, 'original.txt'))
    await fs.writeFile(target, 'new')
    expect((await scanner.deletePath(target, 'permanent')).ok).toBe(false)
    await expect(scanner.assertCurrent(target, 'act')).rejects.toThrow('replaced')
    await expect(scanner.assertCurrent(target, 'read')).rejects.toThrow('replaced')
    expect(await fs.readFile(target, 'utf8')).toBe('new')
  })

  it('lets previews read a file edited in place, but refuses to act on it', async () => {
    const target = path.join(root, 'file.txt')
    await fs.writeFile(target, 'old')
    await scanner.start(root)
    await fs.writeFile(target, 'new contents')
    await expect(scanner.assertCurrent(target, 'read')).resolves.toBeUndefined()
    await expect(scanner.assertCurrent(target, 'act')).rejects.toThrow('“file.txt” changed after the scan')
    expect((await scanner.deletePath(target, 'permanent')).ok).toBe(false)
  })

  it('names a deleted parent folder', async () => {
    const folder = path.join(root, 'folder')
    await fs.mkdir(folder)
    await fs.writeFile(path.join(folder, 'file.txt'), 'x')
    await scanner.start(root)
    await fs.rm(folder, { recursive: true })
    await expect(scanner.assertCurrent(path.join(folder, 'file.txt'), 'read')).rejects.toThrow(
      'The folder “folder” above this item no longer exists'
    )
  })

  it('scans a root reached through a link at its real location', async () => {
    const real = path.join(root, 'real')
    const link = path.join(fixture, 'link')
    await fs.mkdir(real)
    await fs.writeFile(path.join(real, 'file.txt'), 'content')
    await fs.symlink(real, link, 'junction')
    expect(await resolveScanRoot(link)).toBe(real)
    expect(await resolveScanRoot(real)).toBe(real)
    await scanner.start(link)
    expect(scanner.finish({ total: 0, free: 0 }).rootPath).toBe(real)
    await expect(scanner.assertCurrent(path.join(real, 'file.txt'), 'act')).resolves.toBeUndefined()
  })

  it('previews through links the scan followed, but acts only on real paths', async () => {
    const outside = path.join(fixture, 'outside')
    const link = path.join(root, 'linked')
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'file.txt'), 'content')
    await fs.symlink(outside, link, 'junction')
    await scanner.start(root, { followLinks: true })
    await expect(scanner.assertCurrent(path.join(link, 'file.txt'), 'read')).resolves.toBeUndefined()
    await expect(scanner.assertCurrent(path.join(link, 'file.txt'), 'act')).rejects.toThrow('is a symbolic link')
  })

  it('refuses deletion through a parent replaced by a junction', async () => {
    const parent = path.join(root, 'folder')
    const outside = path.join(fixture, 'outside')
    await fs.mkdir(parent)
    await fs.mkdir(outside)
    await fs.writeFile(path.join(parent, 'file.txt'), 'original')
    await fs.writeFile(path.join(outside, 'file.txt'), 'keep me')
    await scanner.start(root)
    await fs.rename(parent, path.join(root, 'old-folder'))
    await fs.symlink(outside, parent, 'junction')
    expect((await scanner.deletePath(path.join(parent, 'file.txt'), 'permanent')).ok).toBe(false)
    expect(await fs.readFile(path.join(outside, 'file.txt'), 'utf8')).toBe('keep me')
  })

  it('allows removing a scanned link but refuses actions through it', async () => {
    const outside = path.join(fixture, 'outside')
    const link = path.join(root, 'linked')
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'file.txt'), 'keep me')
    await fs.symlink(outside, link, 'junction')
    await scanner.start(root, { followLinks: true })
    expect((await scanner.deletePath(path.join(link, 'file.txt'), 'permanent')).ok).toBe(false)
    expect((await scanner.deletePath(link, 'permanent')).ok).toBe(true)
    expect(await fs.readFile(path.join(outside, 'file.txt'), 'utf8')).toBe('keep me')
  })

  it('removes deleted descendants from reports and totals', async () => {
    const folder = path.join(root, 'folder')
    await fs.mkdir(folder)
    await fs.writeFile(path.join(folder, 'file.txt'), 'content')
    await scanner.start(root)
    expect((await scanner.deletePath(folder, 'permanent')).ok).toBe(true)
    expect(scanner.flatten().map((n) => n.path)).toEqual([root])
    expect(scanner.finish({ total: 0, free: 0 }).bytes).toBe(0)
  })
})

describe('duplicate detection', () => {
  it('confirms whole contents when large files have identical head and tail samples', async () => {
    const data = Buffer.alloc(2 * 1024 * 1024, 'a')
    await fs.writeFile(path.join(root, 'a.bin'), data)
    await fs.writeFile(path.join(root, 'b.bin'), data)
    data[1024 * 1024 + 1] = 98
    await fs.writeFile(path.join(root, 'different.bin'), data)
    await scanner.start(root)
    const groups = await scanner.findDuplicates(root)
    expect(groups).toHaveLength(1)
    expect(groups[0].files.map((f) => f.name).sort()).toEqual(['a.bin', 'b.bin'])
  })

  it('excludes files changed after the scan', async () => {
    await fs.writeFile(path.join(root, 'a.txt'), 'same')
    await fs.writeFile(path.join(root, 'b.txt'), 'same')
    await scanner.start(root)
    await fs.writeFile(path.join(root, 'b.txt'), 'now different')
    expect(await scanner.findDuplicates(root)).toEqual([])
  })

  it('stops hashing when canceled and can search again afterward', async () => {
    await Promise.all(Array.from({ length: 40 }, (_, i) => fs.writeFile(path.join(root, `copy-${i}.txt`), 'same')))
    await scanner.start(root)
    const phases: string[] = []
    scanner.onDupProgress = (p) => {
      phases.push(p.phase)
      if (p.phase === 'hashing' && p.hashed >= 8) scanner.cancelDuplicates()
    }
    await scanner.findDuplicates(root)
    expect(phases.at(-1)).toBe('cancelled')
    expect(phases.filter((p) => p === 'hashing').length).toBeLessThan(6)

    phases.length = 0
    scanner.onDupProgress = (p) => phases.push(p.phase)
    const groups = await scanner.findDuplicates(root)
    expect(phases.at(-1)).toBe('done')
    expect(groups[0].count).toBe(40)
  })
})
