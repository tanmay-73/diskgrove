import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { MEDIA_SCHEME } from '../src/shared/preview'
import type { FileChunk } from '../src/shared/types'

const harness = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>(),
  userData: '',
  contents: { mainFrame: { url: 'http://localhost:5173/' }, send: vi.fn(), on: vi.fn() },
  prompt: vi.fn(),
  open: vi.fn(async () => ''),
  trash: vi.fn(),
  media: null as ((request: Request) => Promise<Response>) | null
}))

vi.mock('electron', () => {
  class Window {
    static getAllWindows() {
      return [new Window()]
    }
    static fromWebContents() {
      return new Window()
    }
    webContents = harness.contents
    on = vi.fn()
    isDestroyed = () => false
    loadURL = vi.fn(async () => undefined)
    loadFile = vi.fn(async () => undefined)
  }
  return {
    app: {
      isPackaged: false,
      whenReady: () => Promise.resolve(),
      on: vi.fn(),
      getPath: () => harness.userData,
      setAppUserModelId: vi.fn()
    },
    BrowserWindow: Window,
    ipcMain: {
      handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) =>
        harness.handlers.set(channel, handler)
    },
    dialog: { showMessageBox: harness.prompt },
    protocol: {
      registerSchemesAsPrivileged: vi.fn(),
      handle: (_scheme: string, handler: (request: Request) => Promise<Response>) => {
        harness.media = handler
      }
    },
    shell: { openPath: harness.open, trashItem: harness.trash, showItemInFolder: vi.fn() },
    session: { defaultSession: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() } }
  }
})
vi.mock('../src/main/drives', () => ({ spaceAt: async () => ({ total: 0, free: 0 }), listDrives: async () => [] }))

let fixture: string
let root: string
let target: string
const event = () =>
  ({ sender: harness.contents, senderFrame: harness.contents.mainFrame }) as unknown as IpcMainInvokeEvent
const invoke = (channel: string, ...args: unknown[]) => harness.handlers.get(channel)!(event(), ...args)

beforeAll(async () => {
  fixture = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'diskgrove-ipc-test-'))
  root = path.join(fixture, 'scan')
  target = path.join(root, 'file.txt')
  harness.userData = path.join(fixture, 'settings')
  await fs.mkdir(root)
  await fs.writeFile(target, 'keep me')
  vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173/')
  vi.stubGlobal('__dirname', path.resolve('out/main'))
  await import('../src/main/index')
  // The window is created once the saved settings have loaded.
  await vi.waitFor(() => expect(harness.contents.on).toHaveBeenCalled())
  await invoke('scan:start', root, {})
})

afterAll(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  if (
    path.dirname(fixture) !== (await fs.realpath(os.tmpdir())) ||
    !path.basename(fixture).startsWith('diskgrove-ipc-test-')
  ) {
    throw new Error('Unexpected fixture path')
  }
  await fs.rm(fixture, { recursive: true, force: true })
})

it('rejects subframes, foreign windows and foreign documents before file actions', () => {
  const handler = harness.handlers.get('items:delete')!
  expect(() =>
    handler({ ...event(), senderFrame: { url: 'http://localhost:5173/' } } as IpcMainInvokeEvent, [target], 'permanent')
  ).toThrow('untrusted sender')
  expect(() => handler({ ...event(), sender: {} } as IpcMainInvokeEvent, [target], 'permanent')).toThrow(
    'untrusted sender'
  )
  harness.contents.mainFrame.url = 'https://example.com/'
  try {
    expect(() => handler(event(), [target], 'permanent')).toThrow('untrusted sender')
  } finally {
    harness.contents.mainFrame.url = 'http://localhost:5173/'
  }
  expect(harness.prompt).not.toHaveBeenCalled()
})

it('reads byte ranges of scanned files only', async () => {
  const chunk = (await invoke('item:read', target, 2, 3)) as FileChunk
  expect(new TextDecoder().decode(chunk.bytes)).toBe('ep ')
  expect(chunk).toMatchObject({ offset: 2, size: 7 })
  await expect(invoke('item:read', path.join(fixture, 'outside.txt'), 0, 10)).rejects.toThrow('current scan')
  await expect(invoke('item:read', root, 0, 10)).rejects.toThrow('Only files')
  expect(await invoke('item:times', root)).toMatchObject({ modified: expect.any(Number) })
})

it('searches the scan or one of its folders and validates the arguments', async () => {
  expect(await invoke('scan:search', 'FILE', null, 10)).toMatchObject({ root, total: 1, hits: [{ path: target }] })
  expect(await invoke('scan:search', '*.txt', root, 10)).toMatchObject({ root, total: 1 })
  await expect(Promise.resolve().then(() => invoke('scan:search', 42, root, 10))).rejects.toThrow('query')
  await expect(Promise.resolve().then(() => invoke('scan:search', 'file', 'relative/path', 10))).rejects.toThrow(
    'absolute'
  )
})

it('previews the current contents of a file edited after the scan', async () => {
  const notes = path.join(root, 'notes.txt')
  await fs.writeFile(notes, 'draft')
  await invoke('scan:start', root, {})
  await fs.writeFile(notes, 'final text')
  const chunk = (await invoke('item:read', notes, 0, 100)) as FileChunk
  expect(new TextDecoder().decode(chunk.bytes)).toBe('final text')
  expect(await invoke('item:times', notes)).toMatchObject({ modified: expect.any(Number) })
  await fs.rm(notes)
})

it('streams media from the scan with range support and refuses everything else', async () => {
  const image = path.join(root, 'pixel.png')
  await fs.writeFile(image, Buffer.from('0123456789'))
  await invoke('scan:start', root, {})
  const url = (p: string) => `${MEDIA_SCHEME}://file/?path=${encodeURIComponent(p)}`

  const full = await harness.media!(new Request(url(image)))
  expect(full.status).toBe(200)
  expect(full.headers.get('Content-Type')).toBe('image/png')
  expect(await full.text()).toBe('0123456789')

  const partial = await harness.media!(new Request(url(image), { headers: { Range: 'bytes=2-4' } }))
  expect(partial.status).toBe(206)
  expect(partial.headers.get('Content-Range')).toBe('bytes 2-4/10')
  expect(await partial.text()).toBe('234')

  const suffix = await harness.media!(new Request(url(image), { headers: { Range: 'bytes=-3' } }))
  expect(await suffix.text()).toBe('789')
  expect((await harness.media!(new Request(url(image), { headers: { Range: 'bytes=20-' } }))).status).toBe(416)

  // Not a media type, outside the scan, or a directory.
  expect((await harness.media!(new Request(url(target)))).status).toBe(415)
  expect((await harness.media!(new Request(url(path.join(fixture, 'x.png'))))).status).toBe(404)
  expect((await harness.media!(new Request(url(root)))).status).toBe(404)
  await fs.rm(image)
  await invoke('scan:start', root, {})
})

it('lists what the scan could not read and reveals those entries only', async () => {
  const { shell } = await import('electron')
  const locked = path.join(root, 'locked.bin')
  await fs.writeFile(locked, 'x')
  const lstat = fs.lstat.bind(fs)
  const spy = vi.spyOn(fs, 'lstat').mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
    if (String(args[0]).endsWith(locked))
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
    return lstat(...args)
  })
  try {
    await invoke('scan:start', root, {})
    expect(await invoke('scan:unreadable', 10)).toEqual({
      folders: 0,
      files: 1,
      items: [{ path: locked, kind: 'file', folder: root, code: 'EPERM' }]
    })
    await invoke('item:reveal', locked)
    expect(shell.showItemInFolder).toHaveBeenCalledWith(locked)
    await expect(invoke('item:reveal', path.join(root, 'missing.bin'))).rejects.toThrow('current scan')
  } finally {
    spy.mockRestore()
    await fs.rm(locked)
    await invoke('scan:start', root, {})
  }
})

it('cannot bypass native confirmation by invoking delete directly', async () => {
  harness.prompt.mockResolvedValue({ response: 0 })
  expect(await invoke('items:delete', [target], 'permanent')).toEqual({ mode: 'permanent', deleted: [], failed: [] })
  expect(await fs.readFile(target, 'utf8')).toBe('keep me')
  expect(harness.trash).not.toHaveBeenCalled()
})

it('cannot open a scanned item without native confirmation', async () => {
  harness.prompt.mockResolvedValue({ response: 0 })
  await invoke('item:open', target)
  expect(harness.open).not.toHaveBeenCalled()
  harness.prompt.mockResolvedValue({ response: 1 })
  await invoke('item:open', target)
  expect(harness.open).toHaveBeenCalledWith(target)
})

it('rejects paths outside the scan before showing a dialog', async () => {
  await expect(invoke('items:delete', [fixture], 'permanent')).rejects.toThrow('current scan')
  expect(harness.prompt).not.toHaveBeenCalled()
})

it('locks the scan while a native dialog is pending, then rechecks the file', async () => {
  let respond!: (result: { response: number }) => void
  harness.prompt.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        respond = resolve
      })
  )
  const deletion = invoke('items:delete', [target], 'permanent')
  await expect(invoke('scan:start', fixture, {})).rejects.toThrow('deletion')
  await fs.rename(target, path.join(root, 'original.txt'))
  await fs.writeFile(target, 'replacement')
  respond({ response: 1 })
  expect(await deletion).toMatchObject({ deleted: [], failed: [{ path: target }] })
  expect(await fs.readFile(target, 'utf8')).toBe('replacement')
})
