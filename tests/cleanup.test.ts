import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ shell: { trashItem: vi.fn() } }))
import { Scanner } from '../src/main/scanner'

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

/** A link at `link` to a folder that is then removed. */
async function brokenLink(link: string): Promise<void> {
  const gone = path.join(fixture, `gone-${path.basename(link)}`)
  await fs.mkdir(gone)
  await fs.symlink(gone, link, 'junction')
  await fs.rm(gone, { recursive: true })
}

const paths = (items: Array<{ path: string }>) => items.map((item) => item.path).sort()

describe('empty folders', () => {
  it('lists the outermost folders with no files at any depth', async () => {
    const nested = path.join(root, 'outer', 'middle', 'inner')
    await fs.mkdir(nested, { recursive: true })
    await fs.mkdir(path.join(root, 'outer', 'side'))
    await fs.mkdir(path.join(root, 'keep', 'blank'), { recursive: true })
    await fs.writeFile(path.join(root, 'keep', 'file.txt'), 'x')
    await fs.mkdir(path.join(root, 'deep', 'a', 'b'), { recursive: true })
    await fs.writeFile(path.join(root, 'deep', 'a', 'b', 'file.txt'), 'x')
    await scanner.start(root)

    const result = await scanner.getEmptyFolders(null, 100)
    expect(result.root).toBe(root)
    expect(result.total).toBe(2)
    expect(paths(result.hits)).toEqual([path.join(root, 'keep', 'blank'), path.join(root, 'outer')])
    // Ranked by the empty folders inside, which deleting the outer one removes too.
    expect(result.hits[0]).toMatchObject({ path: path.join(root, 'outer'), folderCount: 3 })

    const below = await scanner.getEmptyFolders(path.join(root, 'outer'), 100)
    expect(paths(below.hits)).toEqual([path.join(root, 'outer', 'middle'), path.join(root, 'outer', 'side')])
    expect((await scanner.getEmptyFolders(null, 1)).hits).toHaveLength(1)
  })

  it('never calls a folder empty when the scan left something in it out', async () => {
    await fs.mkdir(path.join(root, 'hidden'))
    await fs.writeFile(path.join(root, 'hidden', '.keep'), '')
    await fs.mkdir(path.join(root, 'links'))
    await fs.mkdir(path.join(fixture, 'outside'))
    await fs.symlink(path.join(fixture, 'outside'), path.join(root, 'links', 'outside'), 'junction')
    await fs.mkdir(path.join(root, 'broken'))
    await brokenLink(path.join(root, 'broken', 'dangling'))
    await fs.mkdir(path.join(root, 'empty'))
    await scanner.start(root, { skipHidden: true })

    expect(paths((await scanner.getEmptyFolders(null, 100)).hits)).toEqual([path.join(root, 'empty')])
  })

  it('leaves out folders a stopped scan never listed', async () => {
    await fs.mkdir(path.join(root, 'a'))
    await fs.mkdir(path.join(root, 'b'))
    const opendir = fs.opendir.bind(fs)
    vi.spyOn(fs, 'opendir').mockImplementation(async (...args: Parameters<typeof fs.opendir>) => {
      if (path.basename(String(args[0])) === 'a') scanner.cancel()
      return opendir(...args)
    })
    await scanner.start(root)
    const hits = (await scanner.getEmptyFolders(null, 100)).hits
    expect(hits.map((h) => h.path)).not.toContain(path.join(root, 'a'))
  })

  it('reports a folder once its last empty subfolder is deleted', async () => {
    await fs.mkdir(path.join(root, 'parent', 'blank'), { recursive: true })
    await fs.writeFile(path.join(root, 'parent', 'file.txt'), 'x')
    await scanner.start(root)
    expect(paths((await scanner.getEmptyFolders(null, 100)).hits)).toEqual([path.join(root, 'parent', 'blank')])
    expect((await scanner.deletePath(path.join(root, 'parent', 'file.txt'), 'permanent')).ok).toBe(true)
    expect(paths((await scanner.getEmptyFolders(null, 100)).hits)).toEqual([path.join(root, 'parent')])
  })
})

describe('broken links', () => {
  it('finds links whose target is missing, followed or not', async () => {
    await fs.mkdir(path.join(root, 'sub'))
    const dangling = path.join(root, 'sub', 'dangling')
    await brokenLink(dangling)
    await fs.mkdir(path.join(fixture, 'outside'))
    await fs.symlink(path.join(fixture, 'outside'), path.join(root, 'fine'), 'junction')

    for (const followLinks of [false, true]) {
      await scanner.start(root, { followLinks })
      const result = scanner.getBrokenLinks(null, 100)
      expect(result.total).toBe(1)
      expect(result.links[0]).toMatchObject({
        path: dangling,
        name: 'dangling',
        parentPath: path.join(root, 'sub'),
        size: 0
      })
      expect(result.links[0].target).toContain('gone-dangling')
      expect(scanner.getBrokenLinks(path.join(root, 'sub'), 100).total).toBe(1)
      expect(scanner.getBrokenLinks(path.join(root, 'fine'), 100).total).toBe(0)
      expect(scanner.brokenLinkParent(dangling)).toBe(path.join(root, 'sub'))
    }
  })

  it('removes only the link, and forgets links in deleted folders', async () => {
    const first = path.join(root, 'first')
    await brokenLink(first)
    await fs.mkdir(path.join(root, 'sub'))
    await brokenLink(path.join(root, 'sub', 'second'))
    await scanner.start(root)
    expect(scanner.getBrokenLinks(null, 100).total).toBe(2)

    expect(await scanner.deleteMany([first], 'permanent')).toEqual({ mode: 'permanent', deleted: [first], failed: [] })
    await expect(fs.lstat(first)).rejects.toThrow()
    expect((await scanner.deletePath(path.join(root, 'sub'), 'permanent')).ok).toBe(true)
    expect(scanner.getBrokenLinks(null, 100).total).toBe(0)
  })

  it('refuses a link replaced after the scan', async () => {
    const link = path.join(root, 'dangling')
    await brokenLink(link)
    await scanner.start(root)
    await fs.rm(link, { recursive: true, force: true })
    await fs.mkdir(link)
    await fs.writeFile(path.join(link, 'new.txt'), 'keep me')
    const outcome = await scanner.deletePath(link, 'permanent')
    expect(outcome).toMatchObject({ ok: false, error: expect.stringContaining('Rescan') })
    expect(await fs.readFile(path.join(link, 'new.txt'), 'utf8')).toBe('keep me')
  })
})
