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
