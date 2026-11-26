import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ shell: { trashItem: vi.fn() } }))
vi.mock('../src/main/mounts', () => ({
  virtualDevices: async () => new Set<number>(),
  firmlinkDuplicates: async (root: string) => new Set([path.join(root, 'Data', 'Users')])
}))
import { Scanner } from '../src/main/scanner'

let fixture: string

beforeEach(async () => {
  fixture = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'diskgrove-test-'))
})

afterEach(async () => {
  if (
    path.dirname(fixture) !== (await fs.realpath(os.tmpdir())) ||
    !path.basename(fixture).startsWith('diskgrove-test-')
  ) {
    throw new Error('Unexpected fixture path')
  }
  await fs.rm(fixture, { recursive: true, force: true })
})

it('leaves out folders reported as a second path to data already in the scan', async () => {
  for (const dir of ['Users', path.join('Data', 'Users'), path.join('Data', 'Other')]) {
    await fs.mkdir(path.join(fixture, dir), { recursive: true })
    await fs.writeFile(path.join(fixture, dir, 'file.txt'), 'data')
  }
  const scanner = new Scanner()
  await scanner.start(fixture)
  expect(scanner.getNode(path.join(fixture, 'Data', 'Users'))).toBeNull()
  expect(scanner.getNode(path.join(fixture, 'Users', 'file.txt'))?.size).toBe(4)
  expect(scanner.getNode(path.join(fixture, 'Data'))).toMatchObject({ size: 4, fileCount: 1, folderCount: 1 })
  expect(scanner.finish({ total: 0, free: 0 })).toMatchObject({ files: 2, bytes: 8 })
})

it('leaves out folders and files the user excluded by name or pattern', async () => {
  for (const dir of ['node_modules', path.join('app', 'node_modules', 'pkg'), path.join('app', '.git'), 'src']) {
    await fs.mkdir(path.join(fixture, dir), { recursive: true })
  }
  await fs.writeFile(path.join(fixture, 'app', 'node_modules', 'pkg', 'index.js'), 'module')
  await fs.writeFile(path.join(fixture, 'app', '.git', 'HEAD'), 'ref')
  await fs.writeFile(path.join(fixture, 'src', 'main.ts'), 'code')
  await fs.writeFile(path.join(fixture, 'src', 'cache.tmp'), 'temporary')
  await fs.writeFile(path.join(fixture, 'node_modules.txt'), 'kept')

  const opendir = vi.spyOn(fs, 'opendir')
  const scanner = new Scanner()
  await scanner.start(fixture, { exclude: ['node_modules', '.git', '*.tmp'] })
  expect(scanner.getNode(path.join(fixture, 'app', 'node_modules'))).toBeNull()
  expect(scanner.getNode(path.join(fixture, 'app', '.git'))).toBeNull()
  expect(scanner.getNode(path.join(fixture, 'src', 'cache.tmp'))).toBeNull()
  expect(scanner.getNode(path.join(fixture, 'node_modules.txt'))?.size).toBe(4)
  expect(scanner.finish({ total: 0, free: 0 })).toMatchObject({ files: 2, bytes: 8 })
  // Excluded folders are not listed at all, so their contents cost nothing to skip.
  expect(opendir).toHaveBeenCalled()
  expect(opendir.mock.calls.some(([dir]) => String(dir).includes('node_modules'))).toBe(false)
  opendir.mockRestore()
})

it('leaves out an excluded folder by its full path but still scans it as the root', async () => {
  for (const dir of ['Videos', path.join('Other', 'Videos')]) {
    await fs.mkdir(path.join(fixture, dir), { recursive: true })
    await fs.writeFile(path.join(fixture, dir, 'clip.mp4'), 'video')
  }
  const excluded = path.join(fixture, 'Videos') + path.sep
  const scanner = new Scanner()
  await scanner.start(fixture, { exclude: [excluded] })
  expect(scanner.getNode(path.join(fixture, 'Videos'))).toBeNull()
  expect(scanner.getNode(path.join(fixture, 'Other', 'Videos', 'clip.mp4'))?.size).toBe(5)

  await scanner.start(path.join(fixture, 'Videos'), { exclude: [excluded] })
  expect(scanner.finish({ total: 0, free: 0 })).toMatchObject({ files: 1, bytes: 5 })
})
