import { dialog, type BrowserWindow } from 'electron'
import { createWriteStream, promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { topK } from './top-k'
import { formatBytes, formatDate, formatNumber, formatPercent } from '@shared/format'
import type { AgeBucket, ExtensionStat, NodeSummary, ScanComplete } from '@shared/types'
import type { Scanner } from './scanner'
import type { ReportFormat } from './validate'

// Filenames starting with formula prefixes must stay literal in spreadsheets.
export function csvCell(value: string | number): string {
  if (typeof value === 'number') return String(value)
  let s = value
  if (/^[\s\uFEFF]*[=+\-@]|^[\t\r\n]/.test(s)) s = `'${s}`
  if (/[",\r\n]/.test(s) || s !== value) return `"${s.replace(/"/g, '""')}"`
  return s
}

export async function exportReport(
  parent: BrowserWindow | null,
  scanner: Scanner,
  complete: ScanComplete | null,
  extensions: ExtensionStat[],
  topFiles: NodeSummary[],
  age: AgeBucket[],
  format: ReportFormat
): Promise<string | null> {
  const options: Electron.SaveDialogOptions = {
    title: 'Export scan report',
    defaultPath: `diskgrove-report.${format}`,
    filters:
      format === 'csv'
        ? [{ name: 'CSV', extensions: ['csv'] }]
        : format === 'json'
          ? [{ name: 'JSON', extensions: ['json'] }]
          : [{ name: 'HTML', extensions: ['html'] }]
  }
  const { filePath, canceled } = parent
    ? await dialog.showSaveDialog(parent, options)
    : await dialog.showSaveDialog(options)
  if (canceled || !filePath) return null

  const root = complete?.rootPath ?? scanner.getRootPath()

  if (format === 'csv') {
    function* lines() {
      // Excel reads a CSV as UTF-8 only when it starts with a byte order mark.
      yield '﻿Path,Name,Type,Size,Allocated,Files,Folders,Modified'
      for (const n of scanner.summaries()) {
        yield '\n' +
          [
            csvCell(n.path),
            csvCell(n.name),
            n.kind,
            n.size,
            n.allocated,
            n.fileCount,
            n.folderCount,
            csvCell(formatDate(n.mtime))
          ].join(',')
      }
    }
    await writeReport(filePath, lines())
    return filePath
  }

  if (format === 'json') {
    function* lines() {
      const metadata = { generatedAt: new Date().toISOString(), scan: complete, extensions, topFiles, age }
      yield JSON.stringify(metadata, null, 2).slice(0, -1) + ',"nodes":[\n'
      let first = true
      for (const node of scanner.summaries()) {
        yield (first ? '' : ',\n') + JSON.stringify(node)
        first = false
      }
      yield '\n]}\n'
    }
    await writeReport(filePath, lines())
    return filePath
  }

  function* folders() {
    for (const node of scanner.summaries()) if (node.kind === 'dir' && node.path !== root) yield node
  }
  const topFolders = topK(folders(), 30, (a, b) => b.size - a.size)

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'" />
  <title>DiskGrove disk report — ${escapeHtml(root)}</title>
  <style>
    :root { color-scheme: dark; }
    body { font-family: Segoe UI, sans-serif; background: #0f141c; color: #e8edf5; margin: 0; padding: 32px; }
    h1 { font-size: 22px; margin: 0 0 8px; }
    .muted { color: #93a0b5; }
    .cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 20px 0 28px; }
    .card { background: #18202c; border: 1px solid #2a3546; border-radius: 10px; padding: 14px 16px; }
    .card b { display: block; font-size: 18px; margin-top: 6px; }
    table { width: 100%; border-collapse: collapse; margin: 0 0 28px; font-size: 13px; }
    th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #2a3546; }
    th { color: #93a0b5; font-weight: 600; }
    /* Long paths wrap instead of pushing the number columns off the page. */
    td { overflow-wrap: anywhere; }
    td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  </style>
</head>
<body>
  <h1>DiskGrove disk space report</h1>
  <p class="muted">${escapeHtml(root)} · generated ${escapeHtml(new Date().toLocaleString())}</p>
  ${complete?.cancelled ? '<p>This scan was stopped early. Totals cover only the folders it reached.</p>' : ''}
  <div class="cards">
    <div class="card">Size<b>${escapeHtml(formatBytes(complete?.bytes ?? 0))}</b></div>
    <div class="card">Files<b>${escapeHtml(formatNumber(complete?.files ?? 0))}</b></div>
    <div class="card">Folders<b>${escapeHtml(formatNumber(complete?.folders ?? 0))}</b></div>
    <div class="card">Scan time<b>${escapeHtml(String(complete?.elapsedMs ?? 0))} ms</b></div>
  </div>
  <h2>Largest folders</h2>
  ${table(topFolders, complete?.bytes ?? 0)}
  <h2>Largest files</h2>
  ${table(topFiles, complete?.bytes ?? 0)}
  <h2>File types</h2>
  <table>
    <thead><tr><th>Extension</th><th>Category</th><th class="num">Files</th><th class="num">Size</th><th class="num">%</th></tr></thead>
    <tbody>
      ${extensions
        .slice(0, 40)
        .map(
          (e) =>
            `<tr><td>${escapeHtml(e.ext)}</td><td>${escapeHtml(e.category)}</td><td class="num">${escapeHtml(formatNumber(e.count))}</td><td class="num">${escapeHtml(formatBytes(e.size))}</td><td class="num">${escapeHtml(formatPercent(e.percent))}</td></tr>`
        )
        .join('')}
    </tbody>
  </table>
  <h2>File age</h2>
  <table>
    <thead><tr><th>Age</th><th class="num">Files</th><th class="num">Size</th><th class="num">%</th></tr></thead>
    <tbody>
      ${age
        .map(
          (a) =>
            `<tr><td>${escapeHtml(a.label)}</td><td class="num">${escapeHtml(formatNumber(a.count))}</td><td class="num">${escapeHtml(formatBytes(a.size))}</td><td class="num">${escapeHtml(formatPercent(a.percent))}</td></tr>`
        )
        .join('')}
    </tbody>
  </table>
</body>
</html>`

  await writeReport(filePath, [html])
  return filePath
}

async function writeReport(target: string, parts: Iterable<string>): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`
  function* chunks() {
    let buffer = ''
    for (const part of parts) {
      buffer += part
      if (buffer.length >= 64 * 1024) {
        yield buffer
        buffer = ''
      }
    }
    if (buffer) yield buffer
  }
  try {
    await pipeline(
      Readable.from(chunks(), { objectMode: false }),
      createWriteStream(temporary, { flags: 'wx', mode: 0o600 })
    )
    await fs.rename(temporary, target)
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined)
  }
}

function table(rows: NodeSummary[], total: number): string {
  return `<table>
    <thead><tr><th>Name</th><th>Path</th><th class="num">Size</th><th class="num">%</th></tr></thead>
    <tbody>
      ${rows
        .map(
          (n) =>
            `<tr><td>${escapeHtml(n.name)}</td><td>${escapeHtml(n.path)}</td><td class="num">${escapeHtml(formatBytes(n.size))}</td><td class="num">${escapeHtml(formatPercent(total ? (n.size / total) * 100 : 0))}</td></tr>`
        )
        .join('')}
    </tbody>
  </table>`
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
