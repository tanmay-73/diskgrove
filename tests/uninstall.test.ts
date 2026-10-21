import { spawnSync } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const script = path.resolve('resources/uninstall.sh')

let root = ''
let home = ''
let stubs = ''

async function put(file: string, content = ''): Promise<string> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
  return file
}

// Stand-ins for the system tools, so the script sees a chosen OS and no running app.
async function stub(name: string, body: string): Promise<void> {
  await fs.writeFile(path.join(stubs, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
}

function run(platform: 'Darwin' | 'Linux', args: string[], env: Record<string, string> = {}, file = script) {
  return spawnSync('sh', [file, ...args], {
    encoding: 'utf8',
    input: '',
    env: { PATH: `${stubs}${path.delimiter}${process.env.PATH}`, HOME: home, FAKE_OS: platform, ...env }
  })
}

async function appBundle(directory: string, id = 'io.github.tanmay-73.diskgrove'): Promise<string> {
  const bundle = path.join(directory, 'DiskGrove.app')
  await put(path.join(bundle, 'Contents/Info.plist'), `<key>CFBundleIdentifier</key><string>${id}</string>`)
  await put(path.join(bundle, 'Contents/MacOS/DiskGrove'))
  return bundle
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'diskgrove-uninstall-test-')))
  home = path.join(root, 'home')
  stubs = path.join(root, 'stubs')
  await fs.mkdir(home)
  await fs.mkdir(stubs)
  await stub('uname', 'echo "$FAKE_OS"')
  await stub('pgrep', 'exit 1')
  await stub('pkill', 'exit 1')
  await stub('dpkg-query', 'exit 1')
  await stub('defaults', `echo "$@" >> "${path.join(root, 'defaults.log')}"`)
})

afterEach(async () => {
  if (!path.basename(root).startsWith('diskgrove-uninstall-test-')) throw new Error('Unexpected fixture path')
  await fs.rm(root, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('uninstall.sh', () => {
  it('removes the macOS app and its data and leaves other apps alone', async () => {
    const library = path.join(home, 'Library')
    const bundle = await appBundle(path.join(home, 'Applications'))
    const removed = [
      bundle,
      await put(path.join(library, 'Application Support/diskgrove/settings.json'), '{}'),
      await put(path.join(library, 'Caches/io.github.tanmay-73.diskgrove/data')),
      await put(path.join(library, 'Preferences/io.github.tanmay-73.diskgrove.plist')),
      await put(path.join(library, 'Saved Application State/io.github.tanmay-73.diskgrove.savedState/windows.plist'))
    ]
    const kept = [
      await put(path.join(library, 'Application Support/other/settings.json'), '{}'),
      await put(path.join(library, 'Preferences/com.other.app.plist'))
    ]

    const result = run('Darwin', ['-y', '--delete-app-data'])

    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(removed.filter(existsSync)).toEqual([])
    expect(existsSync(path.join(library, 'Application Support/diskgrove'))).toBe(false)
    expect(kept.filter(existsSync)).toEqual(kept)
    expect(await fs.readFile(path.join(root, 'defaults.log'), 'utf8')).toBe('delete io.github.tanmay-73.diskgrove\n')
  })

  it('removes the macOS bundle it is run from', async () => {
    const bundle = await appBundle(path.join(root, 'Custom Apps'))
    const copy = path.join(bundle, 'Contents/Resources/uninstall.sh')
    await fs.mkdir(path.dirname(copy))
    await fs.copyFile(script, copy)

    const result = run('Darwin', ['-y'], {}, copy)

    expect(result.status).toBe(0)
    expect(existsSync(bundle)).toBe(false)
    expect(existsSync(path.dirname(bundle))).toBe(true)
  })

  it.each(['com.example.other', 'io.github.tanmay-73.diskgrove-fork', 'io-github-tanmay-73-diskgrove'])(
    'refuses a bundle that is not DiskGrove (%s)',
    async (id) => {
      const bundle = await appBundle(path.join(home, 'Applications'), id)
      expect(run('Darwin', ['-y', bundle]).status).toBe(2)
      expect(existsSync(bundle)).toBe(true)
    }
  )

  it('skips a foreign bundle found by name while removing DiskGrove data', async () => {
    const bundle = await appBundle(path.join(home, 'Applications'), 'com.example.other')
    const data = await put(path.join(home, 'Library/Application Support/diskgrove/settings.json'), '{}')

    expect(run('Darwin', ['-y', bundle]).status).toBe(2)
    expect(existsSync(bundle)).toBe(true)
    expect(existsSync(data)).toBe(true)

    // found by name only, so it is skipped while DiskGrove's own data still goes
    expect(run('Darwin', ['-y', '--delete-app-data']).status).toBe(0)
    expect(existsSync(bundle)).toBe(true)
    expect(existsSync(data)).toBe(false)
  })

  it('removes the AppImage, its data and its menu entry on Linux', async () => {
    const share = path.join(home, '.local/share')
    const removed = [
      await put(path.join(home, 'Applications/DiskGrove-1.0.0-linux-x86_64.AppImage')),
      await put(path.join(home, '.config/diskgrove/settings.json'), '{}'),
      await put(path.join(share, 'applications/appimagekit_0123abcd-DiskGrove.desktop')),
      await put(path.join(share, 'icons/hicolor/256x256/apps/appimagekit_0123abcd_diskgrove.png'))
    ]
    const kept = [
      await put(path.join(home, 'Applications/Other-1.0.0.AppImage')),
      await put(path.join(home, '.config/other/settings.json'), '{}'),
      await put(path.join(share, 'applications/appimagekit_0123abcd-Other.desktop'))
    ]

    const result = run('Linux', ['-y', '--delete-app-data'])

    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(removed.filter(existsSync)).toEqual([])
    expect(existsSync(path.join(home, '.config/diskgrove'))).toBe(false)
    expect(kept.filter(existsSync)).toEqual(kept)
  })

  it('keeps the settings and drops the caches unless told otherwise', async () => {
    const config = path.join(home, '.config/diskgrove')
    const settings = await put(path.join(config, 'settings.json'), '{"theme":"dark"}')
    await put(path.join(config, 'Cache/Cache_Data/index'))
    await put(path.join(config, 'Local State'), '{}')
    await put(path.join(config, '.org.chromium.Chromium.abc'))
    const appImage = await put(path.join(home, 'Applications/DiskGrove-1.0.0-linux-x86_64.AppImage'))

    const result = run('Linux', ['-y'])

    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Your settings were kept in')
    expect(existsSync(appImage)).toBe(false)
    expect(await fs.readdir(config)).toEqual(['settings.json'])
    expect(await fs.readFile(settings, 'utf8')).toBe('{"theme":"dark"}')
  })

  it('keeps the macOS settings but not the other files in the Library', async () => {
    const library = path.join(home, 'Library')
    const settings = await put(path.join(library, 'Application Support/diskgrove/settings.json'), '{}')
    await put(path.join(library, 'Application Support/diskgrove/GPUCache/data_0'))
    const preferences = await put(path.join(library, 'Preferences/io.github.tanmay-73.diskgrove.plist'))

    const result = run('Darwin', ['-y'])

    expect(result.status).toBe(0)
    expect(await fs.readdir(path.dirname(settings))).toEqual(['settings.json'])
    expect(existsSync(preferences)).toBe(false)
  })

  it('follows XDG_CONFIG_HOME and reports an AppImage it cannot find', async () => {
    const config = path.join(root, 'xdg config')
    const data = await put(path.join(config, 'diskgrove/settings.json'), '{}')

    const result = run('Linux', ['-y', '--delete-app-data'], { XDG_CONFIG_HOME: config })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('The AppImage was not found')
    expect(existsSync(path.dirname(data))).toBe(false)
    expect(existsSync(config)).toBe(true)
  })

  it('removes the AppImage it was extracted from, and the extracted copy', async () => {
    const downloads = path.join(root, 'some where')
    const appImage = await put(path.join(downloads, 'DiskGrove-1.0.0-linux-x86_64.AppImage'))
    const copy = path.join(downloads, 'squashfs-root/resources/uninstall.sh')
    await fs.mkdir(path.dirname(copy), { recursive: true })
    await fs.copyFile(script, copy)

    const result = run('Linux', ['-y'], {}, copy)

    expect(result.status).toBe(0)
    expect(existsSync(appImage)).toBe(false)
    expect(await fs.readdir(downloads)).toEqual([])
  })

  it('removes the data of the .deb package and leaves the package to apt', async () => {
    await stub('dpkg-query', '[ "$3" = diskgrove ] && echo "install ok installed"')
    const data = await put(path.join(home, '.config/diskgrove/settings.json'), '{}')
    const cache = await put(path.join(home, '.cache/diskgrove/data'))

    const result = run('Linux', ['-y', '--delete-app-data'])

    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(result.stdout).not.toContain('The AppImage was not found')
    expect(result.stdout).not.toContain('has been uninstalled')
    expect(result.stdout).toContain('sudo apt remove diskgrove')
    expect(existsSync(path.dirname(data))).toBe(false)
    expect(existsSync(path.dirname(cache))).toBe(false)
  })

  it('points to apt when only the .deb package is left', async () => {
    await stub('dpkg-query', 'echo "install ok installed"')

    const result = run('Linux', ['-y'])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Nothing to remove')
    expect(result.stdout).toContain('sudo apt remove diskgrove')
  })

  it('rejects a path that is not an AppImage', async () => {
    const file = await put(path.join(home, 'notes.txt'))
    expect(run('Linux', ['-y', file]).status).toBe(2)
    expect(run('Linux', ['-y', home]).status).toBe(2)
    expect(existsSync(file)).toBe(true)
  })

  it('removes nothing without confirmation', async () => {
    const data = await put(path.join(home, '.config/diskgrove/settings.json'), '{}')

    const result = run('Linux', [])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('-y')
    expect(existsSync(data)).toBe(true)
  })

  it('stops when the app does not close', async () => {
    await stub('pgrep', 'exit 0')
    await stub('sleep', 'exit 0')
    const data = await put(path.join(home, '.config/diskgrove/settings.json'), '{}')

    const result = run('Linux', ['-y'])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('still running')
    expect(existsSync(data)).toBe(true)
  })

  it('succeeds when nothing is installed', () => {
    const result = run('Darwin', ['-y'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Nothing to remove')
  })
})
