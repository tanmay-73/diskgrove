import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ shell: { trashItem: vi.fn() } }))
import { Scanner } from '../src/main/scanner'

let fixture: string
let root: string
let scanner: Scanner

const failure = (code: string) => Object.assign(new Error(`${code}: test failure`), { code })

/** Makes listing or looking at the given paths fail with the given codes during the test. */
function failOn(opendirs: Record<string, string>, lstats: Record<string, string>): void {
  const opendir = fs.opendir.bind(fs)
  const lstat = fs.lstat.bind(fs)
  const codeFor = (table: Record<string, string>, target: unknown) =>
    Object.entries(table).find(([p]) => String(target).endsWith(p))?.[1]
  vi.spyOn(fs, 'opendir').mockImplementation(async (...args: Parameters<typeof fs.opendir>) => {
    const code = codeFor(opendirs, args[0])
    if (code) throw failure(code)
    return opendir(...args)
  })
  vi.spyOn(fs, 'lstat').mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
    const code = codeFor(lstats, args[0])
    if (code) throw failure(code)
    return lstat(...args)
  })
}

beforeEach(async () => {
  fixture = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'diskgrove-unreadable-test-'))
  root = path.join(fixture, 'scan')
  await fs.mkdir(path.join(root, 'locked'), { recursive: true })
  await fs.mkdir(path.join(root, 'sub', 'deep'), { recursive: true })
  await fs.writeFile(path.join(root, 'locked', 'inner.txt'), 'hidden from the scan')
  await fs.writeFile(path.join(root, 'sub', 'deep', 'inner.txt'), 'hidden too')
  await fs.writeFile(path.join(root, 'sub', 'file.txt'), 'abc')
  await fs.writeFile(path.join(root, 'busy.sys'), 'busy')
  await fs.writeFile(path.join(root, 'gone.txt'), 'gone')
  await fs.writeFile(path.join(root, 'ok.txt'), 'ok')
  scanner = new Scanner()
})

afterEach(async () => {
  vi.restoreAllMocks()
  if (
    path.dirname(fixture) !== (await fs.realpath(os.tmpdir())) ||
    !path.basename(fixture).startsWith('diskgrove-unreadable-test-')
  ) {
    throw new Error('Unexpected fixture path')
  }
  await fs.chmod(path.join(root, 'locked'), 0o755)
  await fs.rm(fixture, { recursive: true, force: true })
})

const at = (...parts: string[]) => path.join(root, ...parts)

it('counts and lists what it could not read, but not what went away mid-scan', async () => {
  failOn(
    { [at('locked')]: 'EACCES', [at('sub', 'deep')]: 'EPERM' },
    { [at('busy.sys')]: 'EBUSY', [at('gone.txt')]: 'ENOENT' }
  )
  await scanner.start(root)
  const result = scanner.finish({ total: 0, free: 0 })
  expect(result).toMatchObject({ unreadable: 3, files: 2, bytes: 5 })

  const list = scanner.getUnreadable(10)
  expect(list).toMatchObject({ folders: 2, files: 1 })
  expect(list.items).toHaveLength(3)
  expect(list.items).toEqual(
    expect.arrayContaining([
      { path: at('locked'), kind: 'dir', folder: at('locked'), code: 'EACCES' },
      { path: at('sub', 'deep'), kind: 'dir', folder: at('sub', 'deep'), code: 'EPERM' },
      { path: at('busy.sys'), kind: 'file', folder: root, code: 'EBUSY' }
    ])
  )
  const limited = scanner.getUnreadable(1)
  expect(limited.items).toHaveLength(1)
  expect(limited.folders + limited.files).toBe(3)
})

it('marks folders it could not list, so they do not pass for empty ones', async () => {
  failOn({ [at('locked')]: 'EACCES' }, {})
  await scanner.start(root)
  expect(scanner.getNode(at('locked'))).toMatchObject({ size: 0, unreadable: true })
  expect(scanner.getNode(at('sub'))).not.toHaveProperty('unreadable')
  expect(scanner.getNode(at('ok.txt'))).not.toHaveProperty('unreadable')
  const children = scanner.getChildren(root, { key: 'name', dir: 'asc' })
  expect(children.dirs.map((d) => [d.name, d.unreadable ?? false])).toEqual([
    ['locked', true],
    ['sub', false]
  ])
  expect(
    scanner
      .flatten()
      .filter((n) => n.unreadable)
      .map((n) => n.path)
  ).toEqual([at('locked')])
})

it('finds the folder listing an unreadable entry, and nothing else', async () => {
  failOn({ [at('locked')]: 'EACCES' }, { [at('busy.sys')]: 'EBUSY', [at('gone.txt')]: 'ENOENT' })
  await scanner.start(root)
  expect(scanner.unreadableParent(at('busy.sys'))).toBe(root)
  expect(scanner.unreadableParent(at('ok.txt'))).toBeNull()
  expect(scanner.unreadableParent(at('gone.txt'))).toBeNull()
  expect(scanner.unreadableParent(at('locked'))).toBeNull()
  expect(scanner.unreadableParent(at('nothing', 'busy.sys'))).toBeNull()
})

it('forgets unreadable items inside something deleted after the scan', async () => {
  failOn({ [at('sub', 'deep')]: 'EPERM' }, { [at('busy.sys')]: 'EBUSY' })
  await scanner.start(root)
  expect(scanner.finish({ total: 0, free: 0 }).unreadable).toBe(2)
  expect((await scanner.deletePath(at('sub'), 'permanent')).ok).toBe(true)
  expect(scanner.finish({ total: 0, free: 0 }).unreadable).toBe(1)
  expect(scanner.getUnreadable(10)).toEqual({
    folders: 0,
    files: 1,
    items: [{ path: at('busy.sys'), kind: 'file', folder: root, code: 'EBUSY' }]
  })
})

it('starts each scan with an empty list', async () => {
  failOn({ [at('locked')]: 'EACCES' }, {})
  await scanner.start(root)
  vi.restoreAllMocks()
  await scanner.start(root)
  expect(scanner.finish({ total: 0, free: 0 }).unreadable).toBe(0)
  expect(scanner.getNode(at('locked'))).not.toHaveProperty('unreadable')
})

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'reports a folder the account has no permission to list',
  async () => {
    await fs.chmod(at('locked'), 0o000)
    await scanner.start(root)
    expect(scanner.getUnreadable(10).items).toEqual([
      { path: at('locked'), kind: 'dir', folder: at('locked'), code: 'EACCES' }
    ])
  }
)
