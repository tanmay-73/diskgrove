import { promises as fs } from 'node:fs'
import { expect, it } from 'vitest'
import {
  firmlinkDuplicates,
  firmlinkPairs,
  firmlinkSources,
  isVolumeRoot,
  parseMacMountPoints,
  parseMountPoints,
  parseVirtualDevices,
  virtualDevices
} from '../src/main/mounts'

it('picks the devices of virtual filesystems out of a mount table', () => {
  const table = [
    '29 33 0:26 / /proc rw,nosuid,nodev,noexec,relatime shared:13 - proc proc rw',
    '32 33 0:28 / /run rw,nosuid,nodev,noexec,relatime shared:5 - tmpfs tmpfs rw,size=1623528k',
    '33 1 8:2 / / rw,relatime shared:1 - ext4 /dev/sda2 rw',
    '90 33 0:300 / /mnt/with\\040-\\040dash rw - sysfs sysfs rw',
    '91 33 259:5 / /mnt/data rw,relatime shared:40 master:2 - ext4 /dev/nvme1n1p1 rw',
    'garbage'
  ].join('\n')
  expect([...parseVirtualDevices(table)].sort((a, b) => a - b)).toEqual([26, 2 ** 20 + 44])
})

it.runIf(process.platform === 'linux')('matches the device numbers the running kernel reports', async () => {
  const devices = await virtualDevices()
  expect(devices.has((await fs.stat('/proc')).dev)).toBe(true)
  expect(devices.has((await fs.stat('/')).dev)).toBe(false)
})

const FIRMLINKS = ['/Users\tUsers', '/usr/local\tusr/local', '/System/Library/Caches\tSystem/Library/Caches', ''].join(
  '\n'
)

it('pairs firmlinks with their data-volume folders only when a scan covers both ends', () => {
  expect(firmlinkPairs(FIRMLINKS, '/').map((p) => p.target)).toEqual([
    '/System/Volumes/Data/Users',
    '/System/Volumes/Data/usr/local',
    '/System/Volumes/Data/System/Library/Caches'
  ])
  expect(firmlinkPairs(FIRMLINKS, '/System')).toEqual([
    { source: '/System/Library/Caches', target: '/System/Volumes/Data/System/Library/Caches' }
  ])
  expect(firmlinkPairs(FIRMLINKS, '/Users')).toEqual([])
  expect(firmlinkPairs(FIRMLINKS, '/System/Volumes/Data')).toEqual([])
})

it.runIf(process.platform === 'darwin')(
  'finds the firmlinked folders and devfs on a real macOS volume layout',
  async () => {
    expect((await firmlinkDuplicates('/')).has('/System/Volumes/Data/Users')).toBe(true)
    expect((await firmlinkDuplicates('/Users')).size).toBe(0)
    expect([...(await virtualDevices())]).toEqual([(await fs.stat('/dev')).dev])
  }
)

it('lists mount points from a mount table, unescaping spaces', () => {
  const table = [
    '29 33 0:26 / /proc rw,nosuid - proc proc rw',
    '33 1 8:2 / / rw,relatime shared:1 - ext4 /dev/sda2 rw',
    '90 33 0:300 / /mnt/my\\040disk rw - ext4 /dev/sdb1 rw',
    'garbage'
  ].join('\n')
  expect([...parseMountPoints(table)]).toEqual(['/proc', '/', '/mnt/my disk'])
})

it('lists mount points from macOS mount output', () => {
  const output = [
    '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
    'devfs on /dev (devfs, local, nobrowse)',
    '/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect, root data)',
    'map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)',
    '/dev/disk5s1 on /Volumes/My Disk (on) (msdos, local, nodev, nosuid, noowners)',
    '//user@server/share on /Volumes/share (smbfs, nodev, nosuid, mounted by user)',
    'garbage'
  ].join('\n')
  expect([...parseMacMountPoints(output)]).toEqual([
    '/',
    '/dev',
    '/System/Volumes/Data',
    '/System/Volumes/Data/home',
    '/Volumes/My Disk (on)',
    '/Volumes/share'
  ])
})

it('reads firmlink sources', () => {
  expect([...firmlinkSources(FIRMLINKS)]).toEqual(['/Users', '/usr/local', '/System/Library/Caches'])
})

it.runIf(process.platform === 'linux')('treats mount points as volume roots and plain folders as not', async () => {
  expect(await isVolumeRoot('/')).toBe(true)
  expect(await isVolumeRoot('/proc')).toBe(true)
  expect(await isVolumeRoot('/proc/self/..')).toBe(true)
  expect(await isVolumeRoot('/usr/bin')).toBe(false)
})

it.runIf(process.platform === 'darwin')('does not mistake firmlinked folders for volumes', async () => {
  expect(await isVolumeRoot('/')).toBe(true)
  expect(await isVolumeRoot('/Users')).toBe(false)
  expect(await isVolumeRoot('/Applications')).toBe(false)
  expect(await isVolumeRoot('/tmp')).toBe(false)
  expect(await isVolumeRoot('/System/Volumes/Data')).toBe(true)
})
