import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppEntry } from '../src/main/apps'
import {
  discoverGames,
  gameLibraryFolders,
  mergeGames,
  parseEpicManifest,
  parseLegendaryInstalled,
  parseSteamManifest,
  parseVdf,
  steamLibraries
} from '../src/main/apps-games'
import { linuxGameLibraries } from '../src/main/apps-linux'
import { gameLibrariesOf, isAppFolder, parseWindowsApps, windowsFolders } from '../src/main/apps-windows'

const LIBRARY_VDF = `"libraryfolders"
{
	"0"
	{
		"path"		"C:\\\\Program Files (x86)\\\\Steam"
		"apps" { "228980" "188645869" }
	}
	// A second drive
	"1"
	{
		"path"		"A:\\\\SteamLibrary"
	}
}`

const manifest = (id: string, name: string, dir: string, size = 1000) => `"AppState"
{
	"appid"		"${id}"
	"name"		"${name}"
	"installdir"		"${dir}"
	"SizeOnDisk"		"${size}"
	"LastUpdated"		"1700000000"
	"buildid"		"42"
}`

describe('launcher records', () => {
  it('reads Valve KeyValues files', () => {
    expect(parseVdf('"a" { "B" "x \\"y\\"" "c" { } } "d" "e"')).toEqual({ a: { b: 'x "y"', c: {} }, d: 'e' })
    expect(steamLibraries(LIBRARY_VDF)).toEqual(['C:\\Program Files (x86)\\Steam', 'A:\\SteamLibrary'])
    // The older format names each library folder directly.
    expect(steamLibraries('"LibraryFolders" { "TimeNextStatsReport" "1" "1" "D:\\\\Games" }')).toEqual(['D:\\Games'])
    expect(steamLibraries('garbage {')).toEqual([])
  })

  it('reads Steam app manifests, rejecting install folders outside steamapps/common', () => {
    expect(parseSteamManifest(manifest('252950', 'Rocket League', 'rocketleague', 44268739992))).toEqual({
      appId: '252950',
      name: 'Rocket League',
      installDir: 'rocketleague',
      sizeOnDisk: 44268739992,
      lastUpdated: 1700000000000,
      buildId: '42'
    })
    expect(parseSteamManifest(manifest('1', 'Escape', '..'))).toBeNull()
    // Steam escapes backslashes in its files.
    expect(parseSteamManifest(manifest('1', 'Escape', '..\\\\..\\\\Windows'))).toBeNull()
    expect(parseSteamManifest(manifest('1', 'Escape', '../etc'))).toBeNull()
    expect(parseSteamManifest(manifest('1', 'Escape', '. . .'))).toBeNull()
    expect(parseSteamManifest(manifest('abc', 'Bad', 'bad'))).toBeNull()
  })

  it('reads Epic and Legendary manifests, leaving out add-ons', () => {
    const item = (extra: object) =>
      JSON.stringify({
        DisplayName: 'Grand Theft Auto V Enhanced',
        InstallLocation: 'A:\\Epic Games\\GTAVEnhanced',
        InstallSize: 103346963483,
        AppVersionString: '1.0.1158.16_v7',
        LaunchExecutable: 'PlayGTAV.exe',
        AppName: 'gta',
        MainGameAppName: '',
        ...extra
      })
    expect(parseEpicManifest(item({}))).toEqual({
      name: 'Grand Theft Auto V Enhanced',
      version: '1.0.1158.16_v7',
      folder: 'A:\\Epic Games\\GTAVEnhanced',
      size: 103346963483,
      executable: 'PlayGTAV.exe'
    })
    expect(parseEpicManifest(item({ AppName: 'dlc', MainGameAppName: 'gta' }))).toBeNull()
    expect(parseEpicManifest('not json')).toBeNull()
    expect(
      parseLegendaryInstalled(
        JSON.stringify({
          Game: { title: 'Game', install_path: '/games/Game', install_size: 5, version: '1', executable: 'g.exe' },
          Dlc: { title: 'Dlc', install_path: '/games/Game', is_dlc: true }
        })
      )
    ).toEqual([{ name: 'Game', version: '1', folder: '/games/Game', size: 5, executable: 'g.exe' }])
  })

  it('finds where each launcher keeps its records', () => {
    const libraries = gameLibrariesOf(
      { Steam: ['c:/program files (x86)/steam', 'C:\\Program Files (x86)\\Steam'], Epic: 'D:\\EpicData' },
      { 'ProgramFiles(x86)': 'C:\\Program Files (x86)', ProgramData: 'C:\\ProgramData' }
    )
    // One Steam install, however its registry keys spell it.
    expect(libraries.steamRoots).toHaveLength(1)
    expect(libraries.steamRoots[0].toLowerCase()).toBe('c:\\program files (x86)\\steam')
    expect(libraries.epicManifests).toEqual([
      'D:\\EpicData\\Manifests',
      'C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests'
    ])
    const linux = linuxGameLibraries('/home/ada', { XDG_CONFIG_HOME: '/cfg' })
    expect(linux.steamRoots).toContain('/home/ada/.local/share/Steam')
    expect(linux.steamRoots).toContain('/home/ada/.var/app/com.valvesoftware.Steam/.local/share/Steam')
    expect(linux.legendary).toContain('/cfg/heroic/legendaryConfig/legendary/installed.json')
  })
})

describe('merging launcher games', () => {
  const game = (name: string, folder: string, source: 'steam' | 'epic' = 'steam'): AppEntry => ({
    name,
    version: 'Build 1',
    publisher: '',
    source,
    footprint: { kind: 'folder', path: folder },
    estimate: 500,
    installedAt: 1
  })

  it('keeps a registered entry for the same folder and adds the rest', () => {
    const registered: AppEntry = {
      name: 'Rocket League',
      version: '',
      publisher: 'Psyonix',
      source: 'desktop',
      footprint: { kind: 'folder', path: 'A:\\SteamLibrary\\steamapps\\common\\rocketleague' },
      estimate: null,
      installedAt: 0,
      icon: { kind: 'image', path: 'C:\\Steam\\steam\\games\\rl.ico' }
    }
    const merged = mergeGames(
      [registered],
      [
        game('Rocket League', 'a:\\steamlibrary\\steamapps\\common\\RocketLeague'),
        game('GTA V', 'A:\\Epic Games\\GTAV', 'epic')
      ],
      true
    )
    expect(merged).toHaveLength(2)
    expect(merged[0]).toMatchObject({
      name: 'Rocket League',
      publisher: 'Psyonix',
      source: 'steam',
      version: 'Build 1',
      estimate: 500,
      icon: registered.icon
    })
    expect(merged[1]).toMatchObject({ name: 'GTA V', source: 'epic' })
  })

  it('stops a launcher from claiming the folder its games install into', () => {
    const folders = windowsFolders({ ProgramFiles: 'C:\\Program Files', SystemRoot: 'C:\\Windows' })
    // Epic's default library is never one app's folder, even with no game installed there.
    expect(isAppFolder('C:\\Program Files\\Epic Games', folders)).toBe(false)
    folders.shared.push(...gameLibraryFolders([game('GTA V', 'A:\\Epic Games\\GTAV', 'epic')], path.win32))
    const [launcher] = parseWindowsApps(
      { Registry: { DisplayName: 'Epic Games Launcher', InstallLocation: 'A:\\Epic Games\\', EstimatedSize: 10 } },
      folders
    )
    expect(launcher.footprint).toBeNull()
    expect(launcher.estimate).toBe(10240)
  })
})

let fixture: string

beforeAll(async () => {
  fixture = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'diskgrove-games-test-'))
})

afterAll(async () => {
  if (!path.basename(fixture).startsWith('diskgrove-games-test-')) throw new Error('Unexpected fixture path')
  await fs.rm(fixture, { recursive: true, force: true })
})

async function write(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
}

describe('discovering launcher games', () => {
  it('lists installed Steam and Epic games across libraries', async () => {
    const steam = path.join(fixture, 'Steam')
    const second = path.join(fixture, 'SteamLibrary')
    const vdf = `"libraryfolders" { "0" { "path" "${steam.replace(/\\/g, '\\\\')}" } "1" { "path" "${second.replace(/\\/g, '\\\\')}" } }`
    await write(path.join(steam, 'steamapps', 'libraryfolders.vdf'), vdf)
    await write(path.join(steam, 'steamapps', 'appmanifest_228980.acf'), manifest('228980', 'Redist', 'Shared'))
    await write(path.join(steam, 'steamapps', 'common', 'Shared', 'redist.exe'), 'x')
    await write(path.join(second, 'steamapps', 'appmanifest_252950.acf'), manifest('252950', 'Rocket League', 'rl', 9))
    await write(path.join(second, 'steamapps', 'common', 'rl', 'game.exe'), 'x')
    // Uninstalled: the manifest is left but the folder is gone.
    await write(path.join(second, 'steamapps', 'appmanifest_1.acf'), manifest('1', 'Gone', 'gone'))

    const epicGame = path.join(fixture, 'Epic Games', 'GTAV')
    await write(path.join(epicGame, 'PlayGTAV.exe'), 'x')
    const manifests = path.join(fixture, 'Manifests')
    await write(
      path.join(manifests, 'A.item'),
      JSON.stringify({
        DisplayName: 'GTA V',
        InstallLocation: epicGame,
        InstallSize: 77,
        LaunchExecutable: 'PlayGTAV.exe'
      })
    )

    const games = await discoverGames(
      { steamRoots: [steam, path.join(fixture, 'missing')], epicManifests: [manifests], legendary: [] },
      {
        path,
        icon: (folder, exe) => (exe ? { kind: 'file', path: path.join(folder, exe) } : null),
        steamIcons: new Map([['252950', { kind: 'theme', name: 'steam_icon_252950', dirs: [] }]])
      }
    )
    const byName = new Map(games.map((g) => [g.name, g]))
    expect([...byName.keys()].sort()).toEqual(['GTA V', 'Redist', 'Rocket League'])
    expect(byName.get('Rocket League')).toMatchObject({
      source: 'steam',
      footprint: { kind: 'folder', path: path.join(second, 'steamapps', 'common', 'rl') },
      estimate: 9,
      icon: { kind: 'theme', name: 'steam_icon_252950' }
    })
    expect(byName.get('GTA V')).toMatchObject({
      source: 'epic',
      footprint: { kind: 'folder', path: epicGame },
      estimate: 77,
      icon: { kind: 'file', path: path.join(epicGame, 'PlayGTAV.exe') }
    })
  })
})
