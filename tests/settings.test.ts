import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ directory: '' }))
vi.mock('electron', () => ({ app: { getPath: () => state.directory } }))

beforeEach(async () => {
  vi.resetModules()
  state.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'diskgrove-settings-test-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  if (
    path.dirname(state.directory) !== path.resolve(os.tmpdir()) ||
    !path.basename(state.directory).startsWith('diskgrove-settings-test-')
  ) {
    throw new Error('Unexpected fixture path')
  }
  await fs.rm(state.directory, { recursive: true, force: true })
})

it('merges concurrent patches and persists their combined result', async () => {
  const { loadSettings, saveSettings } = await import('../src/main/settings')
  await Promise.all([saveSettings({ skipHidden: true }), saveSettings({ followLinks: true })])
  const settings = await loadSettings()
  expect(settings.skipHidden).toBe(true)
  expect(settings.followLinks).toBe(true)
  expect(JSON.parse(await fs.readFile(path.join(state.directory, 'settings.json'), 'utf8'))).toEqual(settings)
  expect(await fs.readdir(state.directory)).toEqual(['settings.json'])
})

it('keeps the last persisted state when a save fails and allows retrying', async () => {
  const { loadSettings, saveSettings } = await import('../src/main/settings')
  await saveSettings({ skipHidden: false })
  vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk unavailable'))
  await expect(saveSettings({ skipHidden: true })).rejects.toThrow('disk unavailable')
  expect((await loadSettings()).skipHidden).toBe(false)
  expect(await fs.readdir(state.directory)).toEqual(['settings.json'])
  expect((await saveSettings({ skipHidden: true })).skipHidden).toBe(true)
})

it('recovers from malformed JSON and ignores unknown settings', async () => {
  await fs.writeFile(path.join(state.directory, 'settings.json'), '{')
  const { loadSettings, saveSettings } = await import('../src/main/settings')
  expect((await loadSettings()).theme).toBe('dark')
  const settings = await saveSettings({ theme: '__proto__', arbitrary: true, recents: [{ path: 'bad\0path' }] })
  expect(settings.theme).toBe('dark')
  expect(settings.recents).toEqual([])
  expect(settings).not.toHaveProperty('arbitrary')
})

it('keeps the font size to the supported steps', async () => {
  const { loadSettings, saveSettings } = await import('../src/main/settings')
  const { stepFontScale } = await import('../src/shared/font-scale')
  expect((await loadSettings()).fontScale).toBe(100)
  expect((await saveSettings({ fontScale: 125 })).fontScale).toBe(125)
  expect((await saveSettings({ fontScale: 1000 })).fontScale).toBe(125)
  expect((await saveSettings({ fontScale: '90' })).fontScale).toBe(125)
  expect(stepFontScale(125, 1)).toBe(150)
  expect(stepFontScale(150, 1)).toBe(150)
  expect(stepFontScale(80, -1)).toBe(80)
  expect(stepFontScale(125, 0)).toBe(100)
  expect(stepFontScale(123, -1)).toBe(90)
})

it('remembers the search scope and rejects unknown scopes', async () => {
  const { loadSettings, saveSettings } = await import('../src/main/settings')
  expect((await loadSettings()).searchScope).toBe('folder')
  expect((await saveSettings({ searchScope: 'all' })).searchScope).toBe('all')
  expect((await saveSettings({ searchScope: 'everywhere' })).searchScope).toBe('all')
  expect((await saveSettings({ searchScope: 'folder' })).searchScope).toBe('folder')
})
