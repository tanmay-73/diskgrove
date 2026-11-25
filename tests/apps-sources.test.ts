import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppEntry } from '../src/main/apps'
import { heroicFiles, parseHeroicGog } from '../src/main/apps-games'
import { discoverHomebrew, homebrewPrefixes, parseReceipt } from '../src/main/apps-homebrew'
import { appStreamInfo, isAppSnap, ownFolder } from '../src/main/apps-linux'
import { bundleRoots } from '../src/main/apps-macos'
import {
  gogApps,
  parseWindowsApps,
  scoopManifest,
  scoopRoots,
  shortcutApps,
  windowsFolders
} from '../src/main/apps-windows'

const FOLDERS = windowsFolders({
  SystemRoot: 'C:\\Windows',
  ProgramFiles: 'C:\\Program Files',
  ProgramW6432: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  ProgramData: 'C:\\ProgramData',
  USERPROFILE: 'C:\\Users\\Ada',
  LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local',
  APPDATA: 'C:\\Users\\Ada\\AppData\\Roaming'
})

const registered = (name: string, version: string, folder: string | null): AppEntry => ({
  name,
  version,
  publisher: '',
  source: 'desktop',
  footprint: folder ? { kind: 'folder', path: folder } : null,
  estimate: 1024,
  installedAt: 0
})

describe('Windows shortcuts', () => {
  const shortcut = (Name: string, Target: string, Version = '', Publisher = '') => ({
    Name,
    Target,
    Version,
    Publisher
  })

  it('adds programs no installer registered, one per folder', () => {
    const apps = shortcutApps(
      [
        shortcut('Editor', 'D:\\Tools\\Editor\\bin\\editor.exe', '3.1'),
        shortcut('Editor (safe mode)', 'D:\\Tools\\Editor\\editor-safe.exe'),
        shortcut('Uninstall Editor', 'D:\\Tools\\Editor\\editor.exe'),
        shortcut('Remover', 'D:\\Tools\\Editor\\unins000.exe'),
        shortcut('Viewer - Shortcut', 'C:\\Users\\Ada\\AppData\\Local\\Programs\\Viewer\\viewer.exe')
      ],
      FOLDERS,
      []
    )
    expect(apps.map((a) => [a.name, a.version, a.source, a.footprint])).toEqual([
      ['Editor', '3.1', 'folder', { kind: 'folder', path: 'D:\\Tools\\Editor' }],
      ['Viewer', '', 'folder', { kind: 'folder', path: 'C:\\Users\\Ada\\AppData\\Local\\Programs\\Viewer' }]
    ])
  })

  it('leaves out Windows, the user’s own folders, shallow folders and folders already listed', () => {
    const listed = [registered('Office', '16', 'C:\\Program Files\\Microsoft Office')]
    const apps = shortcutApps(
      [
        shortcut('Registry Editor', 'C:\\Windows\\regedit.exe'),
        shortcut('Tool', 'C:\\Users\\Ada\\Downloads\\tool\\tool.exe'),
        shortcut('Loose', 'D:\\Downloads\\loose.exe'),
        shortcut('Excel', 'C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE'),
        shortcut(
          'Media Player',
          'C:\\Program Files (x86)\\Windows Media Player\\wmplayer.exe',
          '12.0.26100.1',
          'Microsoft Corporation'
        ),
        shortcut('Installer', 'C:\\ProgramData\\Package Cache\\{id}\\app.exe')
      ],
      FOLDERS,
      listed,
      '26100'
    )
    expect(apps).toEqual(listed)
  })

  it('gives a registered program without a folder the folder its shortcut is in', () => {
    const apps = shortcutApps(
      [
        shortcut('Node.js', 'C:\\Program Files\\nodejs\\node.exe', '22.21.1'),
        shortcut('PowerToys (Preview)', 'C:\\Users\\Ada\\AppData\\Local\\PowerToys\\PowerToys.exe', '0.102.3101.0'),
        shortcut('Other', 'C:\\Program Files\\Other\\other.exe', '1.0')
      ],
      FOLDERS,
      [
        registered('Node.js', '22.21.1', null),
        registered('PowerToys (Preview) x64', '0.102.3101.0', null),
        registered('Unrelated', '1.0', null)
      ]
    )
    expect(apps.map((a) => [a.name, a.footprint?.kind === 'folder' ? a.footprint.path : null])).toEqual([
      ['Node.js', 'C:\\Program Files\\nodejs'],
      ['PowerToys (Preview) x64', 'C:\\Users\\Ada\\AppData\\Local\\PowerToys'],
      ['Unrelated', null],
      ['Other', 'C:\\Program Files\\Other']
    ])
    // The registered entry keeps its own size figure.
    expect(apps[0].estimate).toBe(1024)
  })

  it('does not take an installer cache as the program’s folder', () => {
    const [app] = parseWindowsApps(
      {
        Registry: {
          DisplayName: 'Vendor App',
          InstallLocation: 'C:\\Program Files\\Vendor\\Installer2\\App.{GUID}',
          DisplayIcon: 'C:\\Program Files\\Vendor\\App\\app.exe'
        }
      },
      FOLDERS
    )
    expect(app.footprint).toEqual({ kind: 'folder', path: 'C:\\Program Files\\Vendor\\App' })
  })
})

describe('Windows package managers and GOG', () => {
  it('reads GOG’s registry keys', () => {
    expect(
      gogApps(
        [
          {
            Name: 'Witcher 3',
            Folder: 'D:\\GOG Games\\Witcher 3\\',
            Version: '4.0',
            Exe: 'D:\\GOG Games\\Witcher 3\\bin\\x64\\witcher3.exe'
          },
          { Name: 'Bad', Folder: 'D:\\' }
        ],
        FOLDERS
      )
    ).toEqual([
      {
        name: 'Witcher 3',
        version: '4.0',
        publisher: 'GOG',
        source: 'gog',
        footprint: { kind: 'folder', path: 'D:\\GOG Games\\Witcher 3' },
        estimate: null,
        installedAt: 0,
        icon: { kind: 'file', path: 'D:\\GOG Games\\Witcher 3\\bin\\x64\\witcher3.exe' }
      }
    ])
  })

  it('finds Scoop and reads its manifests', () => {
    expect(scoopRoots({ USERPROFILE: 'C:\\Users\\Ada', ProgramData: 'C:\\ProgramData' })).toEqual([
      'C:\\Users\\Ada\\scoop',
      'C:\\ProgramData\\scoop'
    ])
    expect(scoopRoots({ SCOOP: 'D:\\scoop', USERPROFILE: 'C:\\Users\\Ada' })).toEqual(['D:\\scoop'])
    expect(scoopManifest('{"version":"1.9","shortcuts":[["Code.exe","Visual Studio Code"]]}')).toEqual({
      version: '1.9',
      program: 'Code.exe',
      name: 'Visual Studio Code'
    })
    expect(scoopManifest('{"version":"2"}')).toEqual({ version: '2', program: '', name: '' })
    expect(scoopManifest('nope')).toEqual({ version: '', program: '', name: '' })
  })
})

describe('Heroic', () => {
  it('reads its GOG library and finds its files', () => {
    const json = JSON.stringify({
      installed: [
        { install_path: '/home/ada/Games/Heroic/Cyberpunk 2077/', version: '2.1', appName: '1' },
        { install_path: '/home/ada/Games/Heroic/Cyberpunk 2077', is_dlc: true },
        { version: 'no folder' }
      ]
    })
    expect(parseHeroicGog(json, path.posix)).toEqual([
      {
        name: 'Cyberpunk 2077',
        version: '2.1',
        folder: '/home/ada/Games/Heroic/Cyberpunk 2077',
        size: 0,
        executable: ''
      }
    ])
    expect(parseHeroicGog('[]', path.posix)).toEqual([])
    expect(heroicFiles(['/cfg'], path.posix)).toEqual({
      legendary: ['/cfg/legendary/installed.json', '/cfg/heroic/legendaryConfig/legendary/installed.json'],
      heroicGog: ['/cfg/heroic/gog_store/installed.json']
    })
  })
})

describe('Linux sources', () => {
  it('finds the own folder of a program no package installed', () => {
    const home = '/home/ada'
    expect(ownFolder('/opt/Editor/editor', home)).toBe('/opt/Editor')
    expect(ownFolder('/usr/local/zig/zig', home)).toBe('/usr/local/zig')
    expect(ownFolder('/usr/local/bin/tool', home)).toBeNull()
    expect(ownFolder('/usr/bin/gedit', home)).toBeNull()
    expect(ownFolder('/home/ada/.local/share/JetBrains/Toolbox/apps/idea/bin/idea.sh', home)).toBe(
      '/home/ada/.local/share/JetBrains/Toolbox/apps/idea'
    )
    expect(ownFolder('/home/ada/apps/Blender/blender', home)).toBe('/home/ada/apps/Blender')
    for (const shared of [
      '/home/ada/.local/bin/tool',
      '/home/ada/bin/tool',
      '/home/ada/Downloads/tool',
      '/home/ada/tool',
      '/home/ada/.var/app/org.x.Y/data/bin/tool',
      '/home/ada/.local/share/Steam/ubuntu12_32/steam',
      '/home/adam/apps/Tool/tool',
      'tool'
    ]) {
      expect(ownFolder(shared, home)).toBeNull()
    }
  })

  it('tells app snaps from bases and content snaps', () => {
    expect(isAppSnap('name: lxd\nversion: 5\napps:\n  lxd:\n    command: bin/lxd\n')).toBe(true)
    expect(isAppSnap('name: core22\ntype: base\n')).toBe(false)
    expect(isAppSnap('name: gnome-42-2204\nslots:\n  gnome-42-2204:\n    interface: content\n')).toBe(false)
  })

  it('reads AppStream metadata', () => {
    const xml = `<component><id>org.x.Y</id><name>Y &amp; Z</name><name xml:lang="de">Y und Z</name>
      <releases><release version="2.0" date="2024-01-01"><description><name>not this</name></description></release></releases></component>`
    expect(appStreamInfo(xml)).toEqual({ name: 'Y & Z', version: '2.0' })
  })
})

describe('macOS and Homebrew', () => {
  it('searches the Applications folders deeper than Downloads and the Desktop', () => {
    expect(bundleRoots('/Users/ada')).toEqual([
      ['/Applications', 2],
      ['/Users/ada/Applications', 2],
      ['/Users/Shared', 1],
      ['/Users/ada/Downloads', 1],
      ['/Users/ada/Desktop', 1]
    ])
  })

  it('knows where Homebrew installs and reads its receipts', () => {
    expect(homebrewPrefixes('darwin', '/Users/ada', {})).toEqual(['/opt/homebrew', '/usr/local'])
    expect(homebrewPrefixes('linux', '/home/ada', { HOMEBREW_PREFIX: '/srv/brew' })).toEqual([
      '/srv/brew',
      '/home/linuxbrew/.linuxbrew',
      '/home/ada/.linuxbrew'
    ])
    expect(parseReceipt('{"installed_on_request":true,"time":1700000000}')).toEqual({
      onRequest: true,
      installedAt: 1700000000000
    })
    expect(parseReceipt('{}')).toEqual({ onRequest: false, installedAt: 0 })
    expect(parseReceipt('nope')).toBeNull()
  })
})

let fixture: string

beforeAll(async () => {
  fixture = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'diskgrove-sources-test-'))
})

afterAll(async () => {
  if (!path.basename(fixture).startsWith('diskgrove-sources-test-')) throw new Error('Unexpected fixture path')
  await fs.rm(fixture, { recursive: true, force: true })
})

async function write(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
}

describe('discovering Homebrew formulae', () => {
  it('lists formulae installed on request, with their newest version, and not dependencies', async () => {
    const cellar = path.join(fixture, 'brew', 'Cellar')
    const receipt = (onRequest: boolean, time: number) => JSON.stringify({ installed_on_request: onRequest, time })
    await write(path.join(cellar, 'ffmpeg', '6.0', 'INSTALL_RECEIPT.json'), receipt(true, 100))
    await write(path.join(cellar, 'ffmpeg', '7.1', 'INSTALL_RECEIPT.json'), receipt(true, 200))
    await write(path.join(cellar, 'libpng', '1.6', 'INSTALL_RECEIPT.json'), receipt(false, 100))
    await write(path.join(cellar, 'old', '1.0', 'bin', 'old'), 'x')
    const apps = await discoverHomebrew([path.join(fixture, 'brew'), path.join(fixture, 'missing')])
    const byName = new Map(apps.map((a) => [a.name, a]))
    expect([...byName.keys()].sort()).toEqual(['ffmpeg', 'old'])
    expect(byName.get('ffmpeg')).toMatchObject({
      version: '7.1',
      source: 'homebrew',
      footprint: { kind: 'folder', path: path.posix.join(path.join(fixture, 'brew'), 'Cellar', 'ffmpeg') },
      installedAt: 200000
    })
  })
})
