import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppsProgress, InstalledApp } from '../src/shared/types'
import { imageType, linuxIcon, packagePath, pickLogo, resolveIcon } from '../src/main/app-icons'
import { AppCatalog, markNested, type AppEntry } from '../src/main/apps'
import {
  appImageName,
  execProgram,
  launcherOf,
  optFolder,
  parseDesktopEntry,
  parseDpkgStatus,
  parsePacmanDesc,
  parsePacmanFiles
} from '../src/main/apps-linux'
import { plistStrings } from '../src/main/apps-macos'
import {
  cleanFolder,
  displayIcon,
  inferFolder,
  isAppFolder,
  manifestInfo,
  parseWindowsApps,
  publisherName,
  registryIcon,
  windowsFolders
} from '../src/main/apps-windows'
import { measureFiles, measureFolder } from '../src/main/disk-usage'
import { asAppId } from '../src/main/validate'

const FOLDERS = windowsFolders({
  SystemRoot: 'C:\\Windows',
  ProgramFiles: 'C:\\Program Files',
  ProgramW6432: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  CommonProgramFiles: 'C:\\Program Files\\Common Files',
  ProgramData: 'C:\\ProgramData',
  USERPROFILE: 'C:\\Users\\Ada',
  LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local',
  APPDATA: 'C:\\Users\\Ada\\AppData\\Roaming'
})

describe('Windows apps', () => {
  it('reads registered programs as Settings > Apps lists them', () => {
    const apps = parseWindowsApps(
      {
        Registry: [
          {
            DisplayName: 'Editor',
            DisplayVersion: '2.1',
            Publisher: 'Contoso',
            InstallLocation: '"C:\\Program Files\\Editor\\"',
            EstimatedSize: 2048,
            InstallDate: '20240315',
            DisplayIcon: '"C:\\Program Files\\Editor\\editor.exe",0'
          },
          { DisplayName: 'Driver component', SystemComponent: 1, InstallLocation: 'C:\\Program Files\\Driver' },
          { DisplayName: 'Editor hotfix', ParentKeyName: 'Editor', InstallLocation: 'C:\\Program Files\\Editor' },
          { DisplayName: 'Security Update for Editor (KB5012345)' },
          { DisplayName: 'Runtime', EstimatedSize: 100, InstallLocation: 'C:\\Windows\\System32' },
          { DisplayName: 'Whole drive', InstallLocation: 'C:\\', EstimatedSize: 'not a number' },
          { DisplayName: 'Network share', InstallLocation: '\\\\server\\apps\\Tool' },
          { DisplayName: '   ' }
        ],
        // PowerShell writes a list of one as the item itself.
        Store: {
          Name: 'Contoso.Notes',
          StartName: 'Notes',
          Version: '1.0.0.0',
          Publisher: 'CN=Contoso Ltd, O=Contoso Ltd, C=US',
          InstallLocation: 'C:\\Program Files\\WindowsApps\\Contoso.Notes_1.0.0.0_x64__abc',
          Logo: 'Assets/AppList.png'
        }
      },
      FOLDERS
    )
    expect(apps).toEqual([
      {
        name: 'Editor',
        version: '2.1',
        publisher: 'Contoso',
        source: 'desktop',
        footprint: { kind: 'folder', path: 'C:\\Program Files\\Editor' },
        estimate: 2048 * 1024,
        installedAt: new Date(2024, 2, 15).getTime(),
        icon: { kind: 'file', path: 'C:\\Program Files\\Editor\\editor.exe' }
      },
      expect.objectContaining({ name: 'Runtime', footprint: null, estimate: 100 * 1024 }),
      expect.objectContaining({ name: 'Whole drive', footprint: null, estimate: null }),
      expect.objectContaining({ name: 'Network share', footprint: null }),
      {
        name: 'Notes',
        version: '1.0.0.0',
        publisher: 'Contoso Ltd',
        source: 'store',
        footprint: { kind: 'folder', path: 'C:\\Program Files\\WindowsApps\\Contoso.Notes_1.0.0.0_x64__abc' },
        estimate: null,
        installedAt: 0,
        icon: {
          kind: 'store',
          folder: 'C:\\Program Files\\WindowsApps\\Contoso.Notes_1.0.0.0_x64__abc',
          logo: 'Assets\\AppList.png'
        }
      }
    ])
  })

  it('finds icons named by DisplayIcon on local drives only', () => {
    const env = { ProgramFiles: 'C:\\Program Files' }
    expect(displayIcon('%ProgramFiles%\\Tool\\tool.exe,-101', env)).toEqual({
      kind: 'file',
      path: 'C:\\Program Files\\Tool\\tool.exe'
    })
    expect(displayIcon('C:\\Windows\\Installer\\{GUID}\\product.ico', env)).toEqual({
      kind: 'image',
      path: 'C:\\Windows\\Installer\\{GUID}\\product.ico'
    })
    expect(displayIcon('\\\\server\\share\\tool.exe', env)).toBeNull()
    expect(displayIcon('C:\\Tools\\library.dll,2', env)).toBeNull()
    expect(displayIcon('%Missing%\\tool.exe', env)).toBeNull()
    expect(displayIcon(undefined, env)).toBeNull()
    // Some installers write forward slashes.
    expect(displayIcon('A:/Games/Client/icon.ico', env)).toEqual({ kind: 'image', path: 'A:\\Games\\Client\\icon.ico' })
  })

  it('falls back to the cached Windows Installer icon, then to an uninstaller of the app’s own', () => {
    const icon = (row: Record<string, string>) => registryIcon(row, FOLDERS, {})
    expect(icon({ DisplayIcon: 'C:\\Tools\\tool.exe', ProductIcon: 'C:\\Windows\\Installer\\{A}\\x.ico' })).toEqual({
      kind: 'file',
      path: 'C:\\Tools\\tool.exe'
    })
    expect(icon({ ProductIcon: 'C:\\Windows\\Installer\\{A}\\NodeIcon' })).toEqual({
      kind: 'image',
      path: 'C:\\Windows\\Installer\\{A}\\NodeIcon'
    })
    expect(icon({ ProductIcon: 'C:\\Elsewhere\\icon.ico' })).toBeNull()
    expect(icon({ UninstallString: 'C:\\Users\\Ada\\.cargo\\bin\\rustup.exe self uninstall' })).toEqual({
      kind: 'file',
      path: 'C:\\Users\\Ada\\.cargo\\bin\\rustup.exe'
    })
    expect(icon({ UninstallString: 'C:\\Users\\Ada\\AppData\\Local\\Chat\\Update.exe --uninstall' })).toEqual({
      kind: 'image',
      path: 'C:\\Users\\Ada\\AppData\\Local\\Chat\\app.ico'
    })
    expect(icon({ UninstallString: '"C:\\Program Files\\Tool\\unins000.exe"' })).toBeNull()
    expect(icon({ UninstallString: 'C:\\Windows\\SysWOW64\\RunDll32.EXE tool.dll,Uninstall' })).toBeNull()
    expect(icon({ UninstallString: 'MsiExec.exe /X{0000}' })).toBeNull()
  })

  it('picks the package logo variant drawn nearest the size the list shows', () => {
    const files = [
      'AppList.scale-100.png',
      'AppList.scale-200.png',
      'AppList.targetsize-16.png',
      'AppList.targetsize-48.png',
      'AppList.targetsize-48_altform-unplated.png',
      'AppList.targetsize-48_altform-lightunplated.png',
      'AppList.targetsize-48_contrast-black.png',
      'AppListWide.png',
      'AppList.svg'
    ]
    expect(pickLogo(files, 'Assets\\AppList.png')).toBe('AppList.targetsize-48_altform-unplated.png')
    expect(pickLogo(['StoreLogo.scale-100.png', 'StoreLogo.scale-400.png'], 'StoreLogo.png')).toBe(
      'StoreLogo.scale-100.png'
    )
    expect(pickLogo(['Logo.contrast-white_scale-200.png'], 'Logo.png')).toBe('Logo.contrast-white_scale-200.png')
    expect(pickLogo(['Other.png'], 'Logo.png')).toBeNull()
    expect(packagePath('Assets/Logo.png')).toBe('Assets\\Logo.png')
    for (const outside of ['..\\Logo.png', 'Assets\\..\\..\\Logo.png', 'C:\\Logo.png', '\\Logo.png', '']) {
      expect(packagePath(outside)).toBeNull()
    }
  })

  it('leaves out sparse packages, which belong to a desktop program listed on its own', () => {
    const store = {
      Name: 'Contoso.EditorShell',
      ManifestName: 'Editor',
      External: true,
      InstallLocation: 'C:\\Program Files\\WindowsApps\\Contoso.EditorShell_1.0.0.0_neutral__abc'
    }
    expect(parseWindowsApps({ Store: [store] }, FOLDERS)).toEqual([])
    expect(parseWindowsApps({ Store: [{ ...store, External: false }] }, FOLDERS)).toMatchObject([{ name: 'Editor' }])
  })

  it('finds the folder of a program that registered none from its icon or uninstaller', () => {
    const infer = (row: Record<string, string>) => inferFolder(row, FOLDERS)
    expect(infer({ DisplayIcon: 'C:\\Program Files\\Android\\Android Studio\\bin\\studio.exe' })).toBe(
      'C:\\Program Files\\Android\\Android Studio'
    )
    expect(infer({ DisplayIcon: '"C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe",0' })).toBe(
      'C:\\Program Files\\obs-studio'
    )
    expect(infer({ UninstallString: 'C:\\Users\\Ada\\AppData\\Local\\Chat\\Update.exe --uninstall' })).toBe(
      'C:\\Users\\Ada\\AppData\\Local\\Chat'
    )
    // Installer caches, shared and system folders, icon files and MSI uninstall commands lead nowhere.
    expect(infer({ DisplayIcon: 'C:\\ProgramData\\Package Cache\\{GUID}\\setup.exe' })).toBeNull()
    expect(infer({ DisplayIcon: 'C:\\Program Files (x86)\\InstallShield Installation Information\\{X}\\a.exe' })).toBe(
      null
    )
    expect(infer({ DisplayIcon: 'C:\\Program Files\\Common Files\\Shared\\tool.exe' })).toBeNull()
    expect(infer({ DisplayIcon: 'C:\\Program Files\\Tool.exe' })).toBeNull()
    expect(infer({ DisplayIcon: 'C:\\Program Files (x86)\\Steam\\games\\abc.ico' })).toBeNull()
    expect(infer({ UninstallString: 'MsiExec.exe /X{0000}' })).toBeNull()
    expect(infer({ UninstallString: 'C:\\Windows\\System32\\cleanup.exe' })).toBeNull()
  })

  it('accepts only folders that one app can own', () => {
    expect(cleanFolder('  "D:\\Games\\Racer\\"  ')).toBe('D:\\Games\\Racer')
    expect(cleanFolder('D:\\')).toBe('D:\\')
    expect(cleanFolder('relative\\folder')).toBeNull()
    expect(cleanFolder(42)).toBeNull()
    for (const shared of [
      'D:\\',
      'C:\\Program Files',
      'c:\\program files (x86)\\',
      'C:\\Users\\Ada',
      'C:\\Windows\\Fonts'
    ]) {
      expect(isAppFolder(cleanFolder(shared)!, FOLDERS)).toBe(false)
    }
    expect(isAppFolder('D:\\Games\\Racer', FOLDERS)).toBe(true)
  })

  it('reads package manifests and publishers', () => {
    const manifest = (name: string, extra = '') =>
      `<Package><Properties><DisplayName>${name}</DisplayName>${extra}</Properties><Applications/></Package>`
    expect(manifestInfo(manifest('Notes &amp; Lists'))).toEqual({ name: 'Notes & Lists', external: false, logo: '' })
    expect(manifestInfo(manifest('ms-resource:AppName', '<Logo>Assets\\StoreLogo.png</Logo>'))).toEqual({
      name: '',
      external: false,
      logo: 'Assets\\StoreLogo.png'
    })
    expect(manifestInfo(manifest('Shell', '<uap10:AllowExternalContent>true</uap10:AllowExternalContent>'))).toEqual({
      name: 'Shell',
      external: true,
      logo: ''
    })
    // The app list icon of the first app wins over the store logo.
    const apps = `<Package><Properties><Logo>Assets\\StoreLogo.png</Logo></Properties><Applications>
      <Application Id="App"><uap:VisualElements DisplayName="Notes" Square150x150Logo="Assets\\Tile.png"
        Square44x44Logo="Assets\\AppList.png" BackgroundColor="transparent"/></Application></Applications></Package>`
    expect(manifestInfo(apps).logo).toBe('Assets\\AppList.png')
    expect(publisherName('CN=Contoso, O="Contoso, Ltd", C=US')).toBe('Contoso')
    expect(publisherName('CN=83564403-0B26-46B8-9D84-040F43691D31')).toBe('')
  })
})

describe('macOS apps', () => {
  it('reads the top-level strings of an Info.plist', () => {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleURLTypes</key>
  <array><dict><key>CFBundleShortVersionString</key><string>nested</string></dict></array>
  <key>CFBundleShortVersionString</key>
  <string>4.2 &lt;beta&gt; &#x2603;</string>
  <key>LSRequiresNativeExecution</key><true/>
  <key>CFBundleName</key><string/>
  <key>CFBundleIdentifier</key>
  <string>com.example.editor</string>
</dict>
</plist>`
    const strings = plistStrings(plist)
    expect(strings.get('CFBundleShortVersionString')).toBe('4.2 <beta> ☃')
    expect(strings.get('CFBundleIdentifier')).toBe('com.example.editor')
    expect(strings.get('CFBundleName')).toBe('')
    expect(strings.has('LSRequiresNativeExecution')).toBe(false)
  })
})

describe('Linux apps', () => {
  it('reads the desktop entry group without localized keys', () => {
    const keys = parseDesktopEntry(
      [
        '# comment',
        '[Desktop Entry]',
        'Name[de]=Editor DE',
        'Name=Text Editor',
        'Exec="/opt/My Editor/bin/editor" %F',
        'Type=Application',
        'Comment=Line one\\nline two',
        '[Desktop Action new-window]',
        'Name=New Window'
      ].join('\n')
    )
    expect(keys.get('Name')).toBe('Text Editor')
    expect(keys.get('Comment')).toBe('Line one\nline two')
    expect(execProgram(keys.get('Exec')!)).toBe('/opt/My Editor/bin/editor')
    expect(optFolder(execProgram(keys.get('Exec')!))).toBe('/opt/My Editor')
    expect(optFolder('/opt/../usr/bin/tool')).toBeNull()
    expect(optFolder('/opt/tool')).toBeNull()
  })

  it('finds the program behind env prefixes, and the snap or Flatpak a launcher belongs to', () => {
    expect(execProgram('env BAMF_DESKTOP_FILE_HINT=/var/lib/snapd/desktop/x.desktop /snap/bin/firefox %u')).toBe(
      '/snap/bin/firefox'
    )
    expect(execProgram('  ')).toBe('')
    const entry = (extra: string[]) =>
      parseDesktopEntry(['[Desktop Entry]', 'Type=Application', 'Name=Firefox', ...extra].join('\n'))
    expect(
      launcherOf('firefox_firefox.desktop', '/var/lib/snapd/desktop/applications/firefox_firefox.desktop', entry([]))
    ).toMatchObject({ snap: 'firefox', flatpak: '' })
    expect(launcherOf('org.mozilla.firefox.desktop', '/x', entry(['X-Flatpak=org.mozilla.firefox']))).toMatchObject({
      flatpak: 'org.mozilla.firefox'
    })
    expect(launcherOf('helper.desktop', '/x', entry(['NoDisplay=true']))).toBeNull()
    expect(launcherOf('link.desktop', '/x', parseDesktopEntry('[Desktop Entry]\nType=Link\nName=Docs'))).toBeNull()
  })

  it('reads dpkg and pacman package databases', () => {
    const status = [
      'Package: editor',
      'Status: install ok installed',
      'Installed-Size: 2048',
      'Version: 1.2-1',
      'Description: An editor',
      ' with a continued description line',
      '',
      'Package: removed',
      'Status: deinstall ok config-files',
      'Installed-Size: 10',
      'Version: 0.1'
    ].join('\n')
    expect([...parseDpkgStatus(status).values()]).toEqual([
      { name: 'editor', version: '1.2-1', size: 2048 * 1024, installedAt: 0 }
    ])
    expect(
      parsePacmanDesc('%NAME%\neditor\n\n%VERSION%\n1.2-1\n\n%INSTALLDATE%\n1700000000\n\n%SIZE%\n5000\n')
    ).toEqual({
      name: 'editor',
      version: '1.2-1',
      size: 5000,
      installedAt: 1700000000000
    })
    expect(
      parsePacmanFiles('%FILES%\nusr/\nusr/bin/editor\nusr/share/applications/editor.desktop\n\n%BACKUP%\n')
    ).toEqual(['/usr/', '/usr/bin/editor', '/usr/share/applications/editor.desktop'])
  })

  it('names AppImages after their file', () => {
    expect(appImageName('/home/ada/Applications/Editor-1.5.3-x86_64.AppImage')).toEqual({
      name: 'Editor',
      version: '1.5.3'
    })
    expect(appImageName('/home/ada/Applications/Tool.appimage')).toEqual({ name: 'Tool', version: '' })
  })

  it('reads launcher icons as theme names or image files', () => {
    const keys = parseDesktopEntry('[Desktop Entry]\nType=Application\nName=Editor\nIcon=org.example.Editor')
    expect(launcherOf('editor.desktop', '/x', keys)).toMatchObject({ icon: 'org.example.Editor' })
    const dirs = ['/usr/share']
    expect(linuxIcon('org.example.Editor', dirs)).toEqual({ kind: 'theme', name: 'org.example.Editor', dirs })
    expect(linuxIcon('editor.png', dirs)).toEqual({ kind: 'theme', name: 'editor', dirs })
    expect(linuxIcon('/snap/editor/12/meta/gui/icon.png', dirs)).toEqual({
      kind: 'image',
      path: '/snap/editor/12/meta/gui/icon.png'
    })
    for (const unusable of ['/etc/passwd', '../../etc/editor', 'icons/editor', '..', '']) {
      expect(linuxIcon(unusable, dirs)).toBeNull()
    }
  })
})

let fixture: string

beforeAll(async () => {
  fixture = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'diskgrove-apps-test-'))
})

afterAll(async () => {
  if (
    path.dirname(fixture) !== (await fs.realpath(os.tmpdir())) ||
    !path.basename(fixture).startsWith('diskgrove-apps-test-')
  ) {
    throw new Error('Unexpected fixture path')
  }
  await fs.rm(fixture, { recursive: true, force: true })
})

async function makeApp(name: string, files: Record<string, number>): Promise<string> {
  const folder = path.join(fixture, name)
  for (const [file, size] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(folder, file)), { recursive: true })
    await fs.writeFile(path.join(folder, file), Buffer.alloc(size, 1))
  }
  return folder
}

describe('measuring', () => {
  it('adds up a folder once per file, without following links', async () => {
    const folder = await makeApp('measured', { 'app.bin': 3000, 'lib/a.so': 1000, 'lib/deep/b.so': 500 })
    await fs.link(path.join(folder, 'app.bin'), path.join(folder, 'app-hardlink.bin'))
    const outside = await makeApp('outside', { 'big.bin': 9000 })
    try {
      await fs.symlink(outside, path.join(folder, 'linked'), 'junction')
    } catch {
      /* creating links can need extra rights on Windows */
    }
    expect(await measureFolder(folder, () => false)).toMatchObject({ bytes: 4500, files: 3, partial: false })
    await expect(measureFolder(path.join(fixture, 'missing'), () => false)).rejects.toThrow()
    await expect(measureFolder(path.join(folder, 'app.bin'), () => false)).rejects.toThrow('Not a folder')
    expect(await measureFolder(folder, () => true)).toBeNull()
  })

  it('counts only the regular files a package lists', async () => {
    const folder = await makeApp('package', { 'bin/tool': 700, 'share/doc': 300 })
    const usage = await measureFiles(
      [
        folder,
        path.join(folder, 'bin'),
        path.join(folder, 'bin/tool'),
        path.join(folder, 'share/doc'),
        '/no/such/file'
      ],
      () => false
    )
    expect(usage).toMatchObject({ bytes: 1000, files: 2, partial: false })
  })
})

describe('finding icons', () => {
  it('looks a theme icon up by size in each data folder, then in pixmaps', async () => {
    const user = await makeApp('icons-user', { 'icons/hicolor/256x256/apps/editor.png': 10 })
    const system = await makeApp('icons-system', {
      'icons/hicolor/48x48/apps/editor.png': 10,
      'icons/hicolor/scalable/apps/viewer.svg': 10,
      'icons/hicolor/48x48/apps/empty.png': 0,
      'pixmaps/legacy.png': 10
    })
    const dirs = [user, system]
    const found = async (name: string) => (await resolveIcon({ kind: 'theme', name, dirs }))?.path ?? null
    expect(path.normalize((await found('editor'))!)).toBe(path.join(user, 'icons/hicolor/256x256/apps/editor.png'))
    expect(path.normalize((await found('viewer'))!)).toBe(path.join(system, 'icons/hicolor/scalable/apps/viewer.svg'))
    expect(path.normalize((await found('legacy'))!)).toBe(path.join(system, 'pixmaps/legacy.png'))
    expect(await found('empty')).toBeNull()
    expect(await found('missing')).toBeNull()
  })

  it('uses only image files, and files the system can draw an icon for', async () => {
    const folder = await makeApp('icon-files', { 'logo.png': 10, 'notes.txt': 10, 'app.exe': 10 })
    const logo = path.join(folder, 'logo.png')
    expect(await resolveIcon({ kind: 'image', path: logo })).toEqual({ kind: 'image', path: logo })
    expect(await resolveIcon({ kind: 'image', path: path.join(folder, 'notes.txt') })).toBeNull()
    expect(await resolveIcon({ kind: 'image', path: folder })).toBeNull()
    expect(await resolveIcon({ kind: 'file', path: path.join(folder, 'app.exe') })).toMatchObject({ kind: 'file' })
    expect(await resolveIcon({ kind: 'file', path: path.join(folder, 'gone.exe') })).toBeNull()
    // Cached installer icons can lack an extension; their bytes say what they are when drawn.
    await fs.writeFile(path.join(folder, 'NodeIcon'), Buffer.from([0, 0, 1, 0, 1, 0, 16]))
    expect(await resolveIcon({ kind: 'image', path: path.join(folder, 'NodeIcon') })).toMatchObject({ kind: 'image' })
  })

  it('tells images apart by their first bytes', () => {
    const bytes = (...b: number[]) => Uint8Array.from(b)
    expect(imageType('a', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe('png')
    expect(imageType('a.png', bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('jpeg')
    expect(imageType('NodeIcon', bytes(0, 0, 1, 0, 1, 0, 16, 16))).toBe('ico')
    expect(imageType('logo.svg', new TextEncoder().encode('<svg/>'))).toBe('svg')
    expect(imageType('Tailscale', new TextEncoder().encode('MZ\x90\0'))).toBeNull()
    expect(imageType('logo.png', new TextEncoder().encode('<svg/>'))).toBeNull()
  })

  it.skipIf(process.platform !== 'win32')('finds the best variant of a package logo', async () => {
    const folder = await makeApp('package-logo', {
      'Assets/AppList.scale-200.png': 10,
      'Assets/AppList.targetsize-48_altform-unplated.png': 10
    })
    expect(await resolveIcon({ kind: 'store', folder, logo: 'Assets\\AppList.png' })).toEqual({
      kind: 'image',
      path: path.join(folder, 'Assets', 'AppList.targetsize-48_altform-unplated.png')
    })
    expect(await resolveIcon({ kind: 'store', folder, logo: 'Missing\\Logo.png' })).toBeNull()
  })
})

function entry(name: string, footprint: AppEntry['footprint'], estimate: number | null = null): AppEntry {
  return { name, version: '1', publisher: '', source: 'desktop', footprint, estimate, installedAt: 0 }
}

describe('AppCatalog', () => {
  it('measures each app, counts nested folders once and falls back to installer estimates', async () => {
    const suite = await makeApp('suite', { 'suite.bin': 4000, 'Updater/updater.bin': 1000 })
    const solo = await makeApp('solo', { 'solo.bin': 2000 })
    const events: AppsProgress[] = []
    const catalog = new AppCatalog(async () => [
      entry('Suite', { kind: 'folder', path: suite }),
      entry('Suite Updater', { kind: 'folder', path: path.join(suite, 'Updater') }),
      { ...entry('Solo', { kind: 'folder', path: solo }), icon: { kind: 'file', path: path.join(solo, 'solo.bin') } },
      entry('Solo', { kind: 'folder', path: solo }),
      entry('Gone', { kind: 'folder', path: path.join(fixture, 'gone') }, 8192),
      entry('Unregistered', null, 1024),
      entry('Unknown', null)
    ])
    catalog.onProgress = (p) => events.push(p)
    const { apps, cancelled } = await catalog.list(false)
    const byName = new Map(apps.map((app) => [app.name, app]))

    expect(cancelled).toBe(false)
    expect(apps.map((app) => app.name)).toEqual(['Gone', 'Suite', 'Solo', 'Unregistered', 'Suite Updater', 'Unknown'])
    expect(byName.get('Suite')).toMatchObject({
      size: 5000,
      sizeKind: 'measured',
      insideOf: null,
      locationIsFolder: true
    })
    expect(byName.get('Suite Updater')).toMatchObject({ size: 1000, insideOf: 'Suite' })
    expect(byName.get('Gone')).toMatchObject({ size: 8192, sizeKind: 'estimated', location: null })
    expect(byName.get('Unregistered')).toMatchObject({ size: 1024, sizeKind: 'estimated' })
    expect(byName.get('Unknown')).toMatchObject({ size: null, sizeKind: 'unknown' })
    expect(apps.every((app) => /^[0-9a-f]{16}$/.test(app.id))).toBe(true)

    expect(events[0]).toMatchObject({ phase: 'listing', apps: [] })
    expect(events[1]).toMatchObject({ phase: 'measuring', measured: 0, total: 4 })
    expect(events.at(-1)).toMatchObject({ phase: 'done', measured: 4, total: 4, apps })

    // Only listed apps with a location can be revealed, and the list is kept until a refresh.
    expect(catalog.locationOf(byName.get('Solo')!.id)).toBe(solo)
    expect(catalog.locationOf(byName.get('Gone')!.id)).toBeNull()
    expect(catalog.locationOf('0'.repeat(16))).toBeNull()
    // Icons are looked up by the same IDs.
    expect(byName.get('Solo')).toMatchObject({ hasIcon: true })
    expect(catalog.iconOf(byName.get('Solo')!.id)).toEqual({ kind: 'file', path: path.join(solo, 'solo.bin') })
    expect(byName.get('Suite')).toMatchObject({ hasIcon: false })
    expect(catalog.iconOf(byName.get('Suite')!.id)).toBeNull()
    expect((await catalog.list(false)).apps).toBe(apps)
    expect((await catalog.list(true)).apps).not.toBe(apps)
  })

  it('joins a running listing and leaves sizes unmeasured once stopped', async () => {
    const folder = await makeApp('slow', { 'a.bin': 10 })
    let release!: () => void
    const ready = new Promise<void>((resolve) => {
      release = resolve
    })
    const catalog = new AppCatalog(async () => {
      await ready
      return [entry('Slow', { kind: 'folder', path: folder }, 4096), entry('Other', { kind: 'folder', path: folder })]
    })
    const first = catalog.list(false)
    expect(catalog.list(true)).toBe(first)
    catalog.cancel()
    release()
    const { apps, cancelled } = await first
    expect(cancelled).toBe(true)
    expect(apps.map((app: InstalledApp) => [app.name, app.sizeKind])).toEqual([
      ['Slow', 'estimated'],
      ['Other', 'unknown']
    ])
  })

  it('counts two apps in one folder once', () => {
    const app = (name: string): InstalledApp => ({
      id: name,
      name,
      version: '',
      publisher: '',
      source: 'desktop',
      location: '/opt/suite',
      locationIsFolder: true,
      size: 10,
      allocated: 10,
      sizeKind: 'measured',
      partial: false,
      installedAt: 0,
      insideOf: null,
      hasIcon: false
    })
    expect(markNested([app('First'), app('Second')]).map((a) => a.insideOf)).toEqual([null, 'First'])
  })
})

it('accepts only app IDs in the form the list reports', () => {
  expect(asAppId('0123456789abcdef')).toBe('0123456789abcdef')
  for (const bad of ['', '0123456789ABCDEF', '0123456789abcde', '../../etc/passwd', 42, null]) {
    expect(() => asAppId(bad)).toThrow('app id')
  }
})
