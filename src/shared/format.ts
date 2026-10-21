const numberFormat = new Intl.NumberFormat()
const dateFormat = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit'
})
const longDateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' })

export function formatBytes(bytes: number, decimals = 2): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes === 0) return '0 B'
  const k = 1024
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), units.length - 1)
  const value = bytes / k ** i
  const d = i === 0 ? 0 : value >= 100 ? 1 : decimals
  return `${value.toFixed(d)} ${units[i]}`
}

export function formatNumber(n: number): string {
  return numberFormat.format(n)
}

/** A count and its noun, e.g. "1 file" or "1,024 files". */
export function formatCount(n: number, singular: string, plural = `${singular}s`): string {
  return `${formatNumber(n)} ${n === 1 ? singular : plural}`
}

export function formatPercent(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0%'
  if (n < 0.01) return '<0.01%'
  return `${n.toFixed(n >= 10 ? 1 : 2)}%`
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)} s`
  const m = Math.floor(s / 60)
  const rem = Math.round(s % 60)
  if (m < 60) return `${m}m ${rem}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

export function formatDate(ts: number): string {
  if (!ts) return '—'
  return dateFormat.format(ts)
}

export function formatDateLong(ts: number): string {
  if (!ts) return '—'
  return longDateFormat.format(ts)
}

export function extensionOf(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name
  if (base.startsWith('.') && !base.slice(1).includes('.')) return base.toLowerCase()
  const i = base.lastIndexOf('.')
  if (i <= 0 || i === base.length - 1) return '(none)'
  return base.slice(i).toLowerCase()
}

export function categoryOf(ext: string): string {
  const e = ext.toLowerCase()
  if (['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.webm', '.m4v', '.flv'].includes(e)) return 'Video'
  if (['.mp3', '.wav', '.flac', '.aac', '.ogg', '.wma', '.m4a', '.aiff'].includes(e)) return 'Audio'
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.svg', '.raw', '.psd'].includes(e))
    return 'Images'
  if (['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.iso', '.cab'].includes(e)) return 'Archives'
  if (['.exe', '.msi', '.dll', '.sys', '.bat', '.cmd', '.ps1', '.app', '.dmg', '.so'].includes(e)) return 'Programs'
  if (['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.rtf', '.odt', '.csv', '.md'].includes(e))
    return 'Documents'
  if (
    [
      '.js',
      '.ts',
      '.tsx',
      '.jsx',
      '.py',
      '.java',
      '.c',
      '.cpp',
      '.h',
      '.cs',
      '.go',
      '.rs',
      '.php',
      '.rb',
      '.html',
      '.css',
      '.json',
      '.xml',
      '.yml',
      '.yaml'
    ].includes(e)
  )
    return 'Code'
  if (['.db', '.sqlite', '.mdb', '.bak'].includes(e)) return 'Databases'
  if (['.vmdk', '.vhd', '.vhdx', '.qcow2'].includes(e)) return 'Virtual disks'
  return 'Other'
}
