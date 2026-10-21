// Path helpers for the renderer, which has no `node:path`. Paths come from the scanner, so Windows paths
// start with a drive letter or `\\` and use backslashes; POSIX paths start with `/`. POSIX names may
// contain backslashes, so only `/` separates them there.

export interface PathCrumb {
  label: string
  path: string
}

function isPosix(p: string): boolean {
  return p.startsWith('/')
}

function endsWithSeparator(p: string): boolean {
  return isPosix(p) ? p.endsWith('/') : /[\\/]$/.test(p)
}

/** Whether `target` is `root` or lies below it. */
export function isWithin(root: string, target: string): boolean {
  if (target === root) return true
  if (!target.startsWith(root)) return false
  if (endsWithSeparator(root)) return true
  const next = target[root.length]
  return isPosix(root) ? next === '/' : next === '\\' || next === '/'
}

/** The folders from `root` down to `target`, both included. Just the root when `target` is outside it. */
export function pathCrumbs(root: string, target: string): PathCrumb[] {
  const crumbs: PathCrumb[] = [{ label: root, path: root }]
  if (target === root || !isWithin(root, target)) return crumbs
  const separator = isPosix(root) ? '/' : '\\'
  const segments = target.slice(root.length).split(isPosix(root) ? /\/+/ : /[\\/]+/)
  let current = root
  for (const segment of segments) {
    if (!segment) continue
    current = endsWithSeparator(current) ? current + segment : current + separator + segment
    crumbs.push({ label: segment, path: current })
  }
  return crumbs
}

/** Last segment of a path, keeping roots such as `C:\` or `/` whole. */
export function baseName(p: string): string {
  const trimmed = isPosix(p) ? p.replace(/\/+$/, '') : p.replace(/[\\/]+$/, '')
  if (!trimmed || /^[A-Za-z]:$/.test(trimmed)) return p
  const index = isPosix(p) ? trimmed.lastIndexOf('/') : Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  return trimmed.slice(index + 1) || p
}
