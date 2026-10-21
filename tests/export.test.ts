import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { dialog } from 'electron'
import { exportReport } from '../src/main/export'
import { Scanner } from '../src/main/scanner'

vi.mock('electron', () => ({ dialog: { showSaveDialog: vi.fn() }, shell: { trashItem: vi.fn() } }))

let fixture: string
beforeEach(async () => {
  fixture = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'diskgrove-export-test-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  if (
    path.dirname(fixture) !== (await fs.realpath(os.tmpdir())) ||
    !path.basename(fixture).startsWith('diskgrove-export-test-')
  ) {
    throw new Error('Unexpected fixture path')
  }
  await fs.rm(fixture, { recursive: true, force: true })
})

it.each(['csv', 'json', 'html'] as const)('streams a valid %s report without flattening the scan', async (format) => {
  const root = path.join(fixture, 'scan')
  await fs.mkdir(root)
  await fs.writeFile(path.join(root, '=1+1.txt'), 'example')
  const scanner = new Scanner()
  await scanner.start(root)
  const complete = scanner.finish({ total: 1000, free: 500 })
  const output = path.join(fixture, `report.${format}`)
  vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: output })
  vi.spyOn(scanner, 'flatten').mockImplementation(() => {
    throw new Error('Do not materialize the scan')
  })
  await exportReport(null, scanner, complete, [], [], [], format)
  const bytes = await fs.readFile(output)
  // Only the CSV carries a byte order mark: Excel needs it, JSON parsers reject it.
  expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(format === 'csv')
  const text = bytes.toString('utf8')
  if (format === 'json') {
    const report = JSON.parse(text)
    expect(report.nodes).toHaveLength(2)
    expect(report.scan.bytes).toBe(7)
  } else if (format === 'csv') {
    expect(text.startsWith('﻿Path,Name,')).toBe(true)
    expect(text).toContain('"\'=1+1.txt"')
  } else {
    expect(text).toContain('Content-Security-Policy')
    // Long paths must wrap rather than push the size columns off the page.
    expect(text).toMatch(/td \{ overflow-wrap: anywhere; \}/)
    expect(text).toMatch(/td\.num, th\.num \{[^}]*white-space: nowrap;/)
  }
  expect((await fs.readdir(fixture)).filter((name) => name.endsWith('.tmp'))).toEqual([])
})

it('preserves an existing report if serialization fails', async () => {
  const output = path.join(fixture, 'report.json')
  await fs.writeFile(output, 'original')
  vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: output })
  const scanner = new Scanner()
  vi.spyOn(scanner, 'summaries').mockImplementation(function* () {
    throw new Error('read failed')
  })
  await expect(exportReport(null, scanner, null, [], [], [], 'json')).rejects.toThrow('read failed')
  expect(await fs.readFile(output, 'utf8')).toBe('original')
  expect(await fs.readdir(fixture)).toEqual(['report.json'])
})
