import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { expect, it, vi } from 'vitest'
import { dialog } from 'electron'
import { Scanner } from '../src/main/scanner'
import { exportReport } from '../src/main/export'
import { forEachConcurrent } from '../src/main/concurrency'
import { listDrives } from '../src/main/drives'

vi.mock('electron', () => ({ shell: { trashItem: vi.fn() }, dialog: { showSaveDialog: vi.fn() } }))

it('scans and exports a disposable 10,000-file tree', async () => {
  const fixture = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'diskgrove-disk-bench-'))
  const root = path.join(fixture, 'scan')
  const count = 10_000
  let timer: ReturnType<typeof setInterval> | undefined
  try {
    await fs.mkdir(root)
    for (let dir = 0; dir < 100; dir++) await fs.mkdir(path.join(root, `dir-${dir}`))
    await forEachConcurrent(
      Array.from({ length: count }, (_, i) => i),
      16,
      async (id) => {
        await fs.writeFile(path.join(root, `dir-${Math.floor(id / 100)}`, `file-${id}.bin`), Buffer.alloc(64, id % 256))
      }
    )
    const scanner = new Scanner()
    let lastTick = performance.now()
    let worstTickMs = 0
    timer = setInterval(() => {
      const now = performance.now()
      worstTickMs = Math.max(worstTickMs, now - lastTick)
      lastTick = now
    }, 10)
    const start = performance.now()
    await scanner.start(root)
    const scanMs = performance.now() - start
    clearInterval(timer)
    const complete = scanner.finish({ total: 0, free: 0 })
    expect(complete.files).toBe(count)
    expect(complete.bytes).toBe(count * 64)
    const duplicatesStart = performance.now()
    const duplicates = await scanner.findDuplicates(root)
    const duplicatesMs = performance.now() - duplicatesStart
    expect(duplicates).toHaveLength(256)
    const exports: Record<string, { elapsedMs: number; bytes: number }> = {}
    for (const format of ['csv', 'json'] as const) {
      const output = path.join(fixture, `report.${format}`)
      vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: output })
      const start = performance.now()
      await exportReport(null, scanner, complete, [], [], [], format)
      exports[format] = { elapsedMs: performance.now() - start, bytes: (await fs.stat(output)).size }
      if (format === 'json') expect(JSON.parse(await fs.readFile(output, 'utf8')).nodes).toHaveLength(10_101)
    }
    const drivesStart = performance.now()
    const drives = await listDrives()
    const report = {
      kind: 'real filesystem, freshly created files; warm cache, not cold-disk throughput',
      files: count,
      fileBytes: 64,
      directories: 101,
      scanMs,
      worstTickMs,
      duplicatesMs,
      exports,
      detectedDrives: drives.length,
      driveDiscoveryMs: performance.now() - drivesStart,
      logicalCpus: os.availableParallelism(),
      memoryGiB: os.totalmem() / 2 ** 30,
      uvThreadpoolSize: process.env.UV_THREADPOOL_SIZE || 'default'
    }
    await fs.mkdir('out/benchmarks', { recursive: true })
    const label = process.env.DISKGROVE_BENCH_LABEL || 'disk'
    if (!/^[a-z0-9-]+$/.test(label)) throw new Error('Invalid benchmark label')
    await fs.writeFile(`out/benchmarks/${label}.json`, JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
  } finally {
    clearInterval(timer)
    if (
      path.dirname(fixture) !== (await fs.realpath(os.tmpdir())) ||
      !path.basename(fixture).startsWith('diskgrove-disk-bench-')
    ) {
      throw new Error('Unexpected fixture path')
    }
    await fs.rm(fixture, { recursive: true, force: true })
  }
})
