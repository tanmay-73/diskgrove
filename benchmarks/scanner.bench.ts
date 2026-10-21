import { performance } from 'node:perf_hooks'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => {
  const count = Number(process.env.DISKGROVE_BENCH_FILES || 1_000_000)
  const width = Number(process.env.DISKGROVE_BENCH_WIDTH || 1000)
  if (!Number.isInteger(count) || count < 1 || count > 3_000_000) throw new Error('File count must be 1–3,000,000')
  if (!Number.isInteger(width) || width < 1 || width > count) throw new Error('Invalid directory width')
  return { count, width, active: 0, peakActive: 0 }
})

vi.mock('electron', () => ({ shell: { trashItem: vi.fn() } }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const stats = await actual.promises.stat(process.cwd())
  const entries = function* (target: string) {
    const dir = /dir-(\d+)$/.exec(target)
    const count = dir
      ? Math.min(fixture.width, fixture.count - Number(dir[1]) * fixture.width)
      : Math.ceil(fixture.count / fixture.width)
    for (let i = 0; i < count; i++) {
      yield {
        name: dir ? `file-${i}.bin` : `dir-${i}`,
        isDirectory: () => !dir,
        isFile: () => !!dir,
        isSymbolicLink: () => false
      }
    }
  }
  return {
    ...actual,
    promises: {
      ...actual.promises,
      realpath: async (target: string) => target,
      stat: async () => stats,
      lstat: async (target: string) => {
        fixture.active++
        fixture.peakActive = Math.max(fixture.active, fixture.peakActive)
        await Promise.resolve()
        fixture.active--
        const file = /file-(\d+)\.bin$/.exec(target)
        return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
          size: file ? ((Number(file[1]) * 7919) % 1_000_000) + 1 : 0,
          blocks: 8,
          mode: file ? 0o100644 : 0o40755,
          atime: new Date(stats.atimeMs),
          mtime: new Date(stats.mtimeMs),
          ctime: new Date(stats.ctimeMs),
          birthtime: new Date(stats.birthtimeMs)
        })
      },
      readdir: async (target: string) => [...entries(target)],
      opendir: async (target: string) => ({
        async *[Symbol.asyncIterator]() {
          yield* entries(target)
        }
      })
    }
  }
})

import { Scanner } from '../src/main/scanner'

it('measures synthetic metadata scanning and queries', async () => {
  const scanner = new Scanner()
  const startMemory = process.memoryUsage()
  let peakRss = startMemory.rss
  let worstTickMs = 0
  let lastTick = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    worstTickMs = Math.max(worstTickMs, now - lastTick)
    lastTick = now
    peakRss = Math.max(peakRss, process.memoryUsage().rss)
  }, 10)
  const start = performance.now()
  const root = path.resolve('diskgrove-virtual-benchmark')
  try {
    await scanner.start(root)
    const scanMs = performance.now() - start
    const memory = process.memoryUsage()
    peakRss = Math.max(peakRss, memory.rss)
    const queryStart = performance.now()
    expect(await scanner.getTopFiles(root, 200)).toHaveLength(Math.min(200, fixture.count))
    const topFilesMs = performance.now() - queryStart
    const childrenStart = performance.now()
    const children = scanner.getChildren(path.join(root, 'dir-0'), { key: 'size', dir: 'desc' })
    const childrenMs = performance.now() - childrenStart
    const ipcBytes = Buffer.byteLength(JSON.stringify(children))
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    const report = {
      kind: 'synthetic metadata; no disk I/O or Electron renderer',
      files: fixture.count,
      filesPerDirectory: fixture.width,
      cpu: os.cpus()[0]?.model,
      logicalCpus: os.availableParallelism(),
      memoryGiB: os.totalmem() / 2 ** 30,
      node: process.version,
      scanMs,
      filesPerSecond: fixture.count / (scanMs / 1000),
      topFilesMs,
      childrenMs,
      ipcBytes,
      heapGrowthAtScanEndMiB: (memory.heapUsed - startMemory.heapUsed) / 2 ** 20,
      sampledPeakRssMiB: peakRss / 2 ** 20,
      worstTickMs,
      peakActiveStats: fixture.peakActive
    }
    expect(scanner.finish({ total: 0, free: 0 }).files).toBe(fixture.count)
    console.log(JSON.stringify(report, null, 2))
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    await actual.promises.mkdir('out/benchmarks', { recursive: true })
    const label = process.env.DISKGROVE_BENCH_LABEL || 'latest'
    if (!/^[a-z0-9-]+$/.test(label)) throw new Error('Invalid benchmark label')
    await actual.promises.writeFile(`out/benchmarks/${label}.json`, JSON.stringify(report, null, 2))
  } finally {
    clearInterval(timer)
  }
})
