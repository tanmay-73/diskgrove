import { hierarchy, treemap, treemapSquarify } from 'd3-hierarchy'
import type { HierarchyRectangularNode } from 'd3-hierarchy'
import type { TreemapNode } from './types'

export type TreemapColorMode = 'folder' | 'type'

export const FREE_SPACE_PATH = '__free__'
export const OTHER_SUFFIX = '::__other__'

export const HEADER_HEIGHT = 18
const MIN_HEADER_WIDTH = 48
const MIN_CELL = 2

export interface TreemapTheme {
  palette: string[]
  background: string
  foreground: string
  muted: string
}

export interface TreemapCell {
  x0: number
  y0: number
  x1: number
  y1: number
  node: TreemapNode
  parentPath: string | null
  depth: number
  /** Drawn with nested children inside it, rather than as a solid tile. */
  isFrame: boolean
  /** Frame tall and wide enough to carry a title bar. */
  hasHeader: boolean
  special: 'free' | 'other' | null
  fill: string
  text: string
  subtext: string
}

export interface TreemapLegendEntry {
  label: string
  color: string
  value: number
}

export interface TreemapLayout {
  cells: TreemapCell[]
  legend: TreemapLegendEntry[]
  total: number
}

type Rgb = [number, number, number]

function parseHex(color: string): Rgb | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())
  if (!m) return null
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1]
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb
}

function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b]
    .map((v) =>
      Math.round(Math.min(255, Math.max(0, v)))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`
}

/** Blend `a` toward `b`; `amount` 0 keeps `a`, 1 gives `b`. Non-hex input returns `a`. */
export function mixColors(a: string, b: string, amount: number): string {
  const ca = parseHex(a)
  const cb = parseHex(b)
  if (!ca || !cb) return a
  const t = Math.min(1, Math.max(0, amount))
  return toHex([0, 1, 2].map((i) => ca[i] + (cb[i] - ca[i]) * t) as Rgb)
}

function luminance(color: string): number | null {
  const rgb = parseHex(color)
  if (!rgb) return null
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  if (la === null || lb === null) return 1
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** Whichever of the candidates reads best on `fill`. */
export function readableOn(fill: string, candidates: string[]): string {
  let best = candidates[0]
  let bestRatio = -1
  for (const c of candidates) {
    const ratio = contrastRatio(fill, c)
    if (ratio > bestRatio) {
      best = c
      bestRatio = ratio
    }
  }
  return best
}

function specialOf(node: TreemapNode): TreemapCell['special'] {
  if (node.path === FREE_SPACE_PATH) return 'free'
  if (node.path.endsWith(OTHER_SUFFIX)) return 'other'
  return null
}

// The scanner reports extensions with their dot (".mp4"), or "(none)" for names like Makefile
// and the extensionless executables common on macOS and Linux.
function extLabel(ext: string): string {
  return !ext || ext === '(none)' ? 'No extension' : `.${ext.replace(/^\./, '')}`
}

function canHaveHeader(node: HierarchyRectangularNode<TreemapNode>): boolean {
  return node.x1 - node.x0 >= MIN_HEADER_WIDTH && node.y1 - node.y0 >= HEADER_HEIGHT * 2
}

export function layoutTreemap(
  data: TreemapNode,
  width: number,
  height: number,
  mode: TreemapColorMode,
  theme: TreemapTheme
): TreemapLayout {
  const root = hierarchy(data, (d) => d.children)
    .sum((d) => (d.children?.length ? 0 : Math.max(0, d.value)))
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))

  treemap<TreemapNode>()
    .tile(treemapSquarify)
    .size([width, height])
    .paddingInner(2)
    .paddingOuter(2)
    // d3 positions a node before asking for its padding, so the title bar is
    // only reserved on folders big enough to show it.
    .paddingTop((node) => (node.depth === 0 ? 2 : canHaveHeader(node) ? HEADER_HEIGHT : 2))
    .round(true)(root)

  const laid = root as HierarchyRectangularNode<TreemapNode>
  const total = laid.value ?? 0
  const { palette, background, foreground, muted } = theme
  const textChoices = [foreground, background, '#ffffff', '#101418']
  const neutral = mixColors(foreground, background, 0.82)

  // Folder mode: each top-level item owns a hue that its contents inherit.
  const branchColor = new Map<string, string>()
  let colorIndex = 0
  for (const child of laid.children ?? []) {
    if (specialOf(child.data)) continue
    branchColor.set(child.data.path, palette[colorIndex++ % palette.length])
  }

  // Type mode: the extensions taking the most room get distinct colors.
  const extTotals = new Map<string, number>()
  if (mode === 'type') {
    for (const leaf of laid.leaves()) {
      if (leaf.depth === 0 || leaf.data.kind !== 'file' || specialOf(leaf.data)) continue
      const key = leaf.data.ext.toLowerCase()
      extTotals.set(key, (extTotals.get(key) ?? 0) + (leaf.value ?? 0))
    }
  }
  const rankedExts = [...extTotals.entries()].sort((a, b) => b[1] - a[1])
  const extColor = new Map<string, string>()
  rankedExts.slice(0, palette.length).forEach(([ext], i) => extColor.set(ext, palette[i]))
  const otherTypeColor = mixColors(foreground, background, 0.6)
  const folderTileColor = mixColors(foreground, background, 0.72)

  const cells: TreemapCell[] = []
  laid.each((node) => {
    if (!node.parent) return
    const w = node.x1 - node.x0
    const h = node.y1 - node.y0
    if (w < MIN_CELL || h < MIN_CELL) return
    const special = specialOf(node.data)
    const isFrame = Boolean(node.children?.length)
    const hasHeader = isFrame && canHaveHeader(node)

    let fill: string
    let subtext: string
    if (special === 'free') {
      fill = muted
      subtext = 'Free space'
    } else if (special === 'other') {
      fill = neutral
      subtext = 'Smaller items'
    } else if (mode === 'folder') {
      const branch = node.ancestors().find((a) => a.depth === 1)
      const base = branchColor.get(branch?.data.path ?? '') ?? palette[0]
      // Frames are pale tints that deepen with nesting; tiles carry the hue.
      fill = isFrame
        ? mixColors(base, background, Math.max(0.45, 0.78 - 0.1 * (node.depth - 1)))
        : mixColors(base, background, Math.min(0.3, 0.1 * (node.depth - 1)))
      subtext = node.data.kind === 'dir' ? 'Folder' : extLabel(node.data.ext)
    } else if (isFrame) {
      fill = mixColors(foreground, background, Math.max(0.78, 0.9 - 0.04 * (node.depth - 1)))
      subtext = 'Folder'
    } else if (node.data.kind === 'dir') {
      fill = folderTileColor
      subtext = 'Folder'
    } else {
      fill = extColor.get(node.data.ext.toLowerCase()) ?? otherTypeColor
      subtext = extLabel(node.data.ext)
    }

    cells.push({
      x0: node.x0,
      y0: node.y0,
      x1: node.x1,
      y1: node.y1,
      node: node.data,
      parentPath: node.parent.data.path,
      depth: node.depth,
      isFrame,
      hasHeader,
      special,
      fill,
      text: readableOn(fill, textChoices),
      subtext
    })
  })

  const legend: TreemapLegendEntry[] = []
  if (mode === 'type') {
    for (const [ext, value] of rankedExts.slice(0, palette.length)) {
      legend.push({ label: extLabel(ext), color: extColor.get(ext)!, value })
    }
    const rest = rankedExts.slice(palette.length).reduce((sum, [, v]) => sum + v, 0)
    if (rest > 0) legend.push({ label: 'Other types', color: otherTypeColor, value: rest })
    const folderTiles = laid
      .leaves()
      .filter((l) => l.depth > 0 && l.data.kind === 'dir' && !specialOf(l.data))
      .reduce((sum, l) => sum + (l.value ?? 0), 0)
    if (folderTiles > 0) legend.push({ label: 'Folders (deeper)', color: folderTileColor, value: folderTiles })
  }

  return { cells, legend, total }
}
