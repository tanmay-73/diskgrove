import type { DeleteMode, FileGroup, SortDir, SortKey, SortSpec } from '@shared/types'
import path from 'node:path'

export type ReportFormat = 'csv' | 'json' | 'html'

export interface ScanOptions {
  followLinks: boolean
  skipHidden: boolean
}

const MAX_PATH_LENGTH = 32767
const MAX_QUERY_LENGTH = 256
const MAX_DELETE_BATCH = 10000

const SORT_KEYS: ReadonlySet<string> = new Set<SortKey>([
  'name',
  'size',
  'allocated',
  'files',
  'folders',
  'mtime',
  'percent'
])
const SORT_DIRS: ReadonlySet<string> = new Set<SortDir>(['asc', 'desc'])
const FORMATS: ReadonlySet<string> = new Set<ReportFormat>(['csv', 'json', 'html'])
const DELETE_MODES: ReadonlySet<string> = new Set<DeleteMode>(['trash', 'permanent'])

export class IpcArgumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IpcArgumentError'
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

export function asPath(value: unknown, name = 'path'): string {
  if (typeof value !== 'string' || value.length === 0) throw new IpcArgumentError(`${name} must be a non-empty string`)
  if (value.length > MAX_PATH_LENGTH) throw new IpcArgumentError(`${name} is too long`)
  if (value.includes('\0')) throw new IpcArgumentError(`${name} contains a NUL character`)
  if (!path.isAbsolute(value)) throw new IpcArgumentError(`${name} must be an absolute path`)
  return value
}

export function asOptionalPath(value: unknown, name = 'path'): string | null {
  return value === null || value === undefined ? null : asPath(value, name)
}

export function asPathList(value: unknown, name = 'paths'): string[] {
  if (!Array.isArray(value)) throw new IpcArgumentError(`${name} must be an array`)
  if (value.length === 0 || value.length > MAX_DELETE_BATCH) throw new IpcArgumentError(`${name} has an invalid length`)
  return value.map((item, i) => asPath(item, `${name}[${i}]`))
}

export function asDeleteMode(value: unknown): DeleteMode {
  if (typeof value !== 'string' || !DELETE_MODES.has(value)) throw new IpcArgumentError('unsupported delete mode')
  return value as DeleteMode
}

export function asInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

export function asNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

export function asQuery(value: unknown): string {
  if (typeof value !== 'string') throw new IpcArgumentError('query must be a string')
  return value.slice(0, MAX_QUERY_LENGTH)
}

export function asFileGroup(value: unknown): FileGroup {
  const v = asRecord(value)
  if (v.by === 'ext' && typeof v.ext === 'string') return { by: 'ext', ext: v.ext.slice(0, MAX_QUERY_LENGTH) }
  if (v.by === 'age' && typeof v.id === 'string') return { by: 'age', id: v.id.slice(0, MAX_QUERY_LENGTH) }
  throw new IpcArgumentError('unsupported file group')
}

export function asSort(value: unknown): SortSpec {
  const v = asRecord(value)
  return {
    key: typeof v.key === 'string' && SORT_KEYS.has(v.key) ? (v.key as SortKey) : 'size',
    dir: typeof v.dir === 'string' && SORT_DIRS.has(v.dir) ? (v.dir as SortDir) : 'desc'
  }
}

export function asScanOptions(value: unknown): ScanOptions {
  const v = asRecord(value)
  return { followLinks: v.followLinks === true, skipHidden: v.skipHidden === true }
}

export function asFormat(value: unknown): ReportFormat {
  if (typeof value !== 'string' || !FORMATS.has(value)) throw new IpcArgumentError('unsupported report format')
  return value as ReportFormat
}
