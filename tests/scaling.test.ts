import { expect, it } from 'vitest'
import { forEachConcurrent, walkQueue } from '../src/main/concurrency'
import { topK } from '../src/main/top-k'
import { parseWindowsDrives } from '../src/main/drives'

it('stops scheduling after failure and waits for active jobs before rejecting', async () => {
  let completed = false
  let release!: () => void
  const work = forEachConcurrent([0, 1, 2], 2, async (id) => {
    if (id === 0) {
      await Promise.resolve()
      throw new Error('failure')
    }
    expect(id).toBe(1)
    await new Promise<void>((resolve) => {
      release = resolve
    })
    completed = true
  })
  const assertion = expect(work).rejects.toThrow('failure')
  await Promise.resolve()
  expect(completed).toBe(false)
  release()
  await assertion
  expect(completed).toBe(true)
})

it('bounds active jobs without materializing a promise per item', async () => {
  let active = 0
  let peak = 0
  let completed = 0
  function* jobs() {
    for (let i = 0; i < 10_000; i++) yield i
  }
  await forEachConcurrent(jobs(), 6, async () => {
    peak = Math.max(peak, ++active)
    await Promise.resolve()
    active--
    completed++
  })
  expect(completed).toBe(10_000)
  expect(peak).toBe(6)
})

it('drains dynamically discovered directories with bounded workers', async () => {
  let count = 0
  let active = 0
  let peak = 0
  await walkQueue(
    0,
    4,
    async (depth, enqueue) => {
      peak = Math.max(peak, ++active)
      if (depth < 5) for (let i = 0; i < 5; i++) enqueue(depth + 1)
      await Promise.resolve()
      active--
      count++
    },
    () => false
  )
  expect(count).toBe(3906)
  expect(peak).toBeLessThanOrEqual(4)
})

it('discards pending directories when canceled and waits for active work', async () => {
  let canceled = false
  let count = 0
  await walkQueue(
    0,
    4,
    async (item, enqueue) => {
      count++
      if (!item) for (let i = 1; i <= 10_000; i++) enqueue(i)
      else canceled = true
      await Promise.resolve()
    },
    () => canceled
  )
  expect(count).toBeLessThanOrEqual(5)
})

it('selects the same top results as a full sort for both directions and ties', () => {
  const values = Array.from({ length: 10_000 }, (_, id) => ({ id, size: (id * 7919) % 313 }))
  for (const direction of [1, -1]) {
    const compare = (a: (typeof values)[number], b: (typeof values)[number]) =>
      direction * (a.size - b.size) || a.id - b.id
    for (const limit of [0, 1, 200, 15_000]) {
      expect(topK(values, limit, compare)).toEqual([...values].sort(compare).slice(0, limit))
    }
  }
})

it('discovers hundreds of folder-mounted Windows volumes alongside mapped drives', () => {
  const Volumes = Array.from({ length: 200 }, (_, id) => ({
    DeviceID: `volume-${id}`,
    DriveLetter: null,
    Label: `Disk ${id}`,
    FileSystem: 'NTFS',
    DriveType: 3,
    Capacity: 1000,
    FreeSpace: 500
  }))
  const Mounts = Volumes.map((row, id) => ({ Volume: row.DeviceID, Path: `C:\\mounts\\disk-${id}\\` }))
  const result = parseWindowsDrives({
    Volumes,
    Mounts,
    Logical: [{ DeviceID: 'Z:', DriveType: 4, Size: 2000, FreeSpace: 1000, VolumeName: 'NAS' }]
  })
  expect(result).toHaveLength(201)
  expect(result.find((drive) => drive.path === 'Z:\\')?.kind).toBe('network')
  expect(result.find((drive) => drive.path === 'C:\\mounts\\disk-199\\')?.total).toBe(1000)
})

it('does not duplicate drive letters or list unmounted/invalid Windows volumes', () => {
  const volume = { DeviceID: 'volume-1', DriveLetter: 'D:', Capacity: 1000, FreeSpace: 500 }
  expect(
    parseWindowsDrives({
      Logical: [{ DeviceID: 'D:', Size: 1000, FreeSpace: 500 }],
      Volumes: [volume, { ...volume, DeviceID: 'hidden', DriveLetter: null }],
      Mounts: [{ Volume: 'volume-1', Path: 'C:\\alias\\' }]
    })
  ).toHaveLength(1)
  expect(parseWindowsDrives({ Volumes: [{ ...volume, Capacity: Infinity }] })).toEqual([])
})
