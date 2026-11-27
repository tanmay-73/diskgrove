import { hierarchy, partition } from 'd3-hierarchy'
import type { HierarchyRectangularNode } from 'd3-hierarchy'
import { extLabel, mixColors, readableOn, specialOf, typeColoring } from './treemap-layout'
import type { TreemapColorMode, TreemapLegendEntry, TreemapTheme } from './treemap-layout'
import type { TreemapNode } from './types'

const TAU = Math.PI * 2
/** Share of the radius given to the disc in the middle, which stands for the folder itself. */
export const HOLE_RATIO = 0.24
/** Slices shorter than this along their outer edge aren't drawn. */
const MIN_ARC_PX = 1.5

export interface SunburstArc {
  /** Angles in radians, clockwise from 12 o'clock. */
  a0: number
  a1: number
  /** Inner and outer radius in pixels. */
  r0: number
  r1: number
  node: TreemapNode
  parentPath: string | null
  depth: number
  special: 'free' | 'other' | null
  fill: string
  text: string
  subtext: string
}

export interface SunburstLayout {
  arcs: SunburstArc[]
  legend: TreemapLegendEntry[]
  total: number
  /** Radius of the disc in the middle. */
  hole: number
  /** Width of one ring. */
  ring: number
}

export function layoutSunburst(
  data: TreemapNode,
  radius: number,
  mode: TreemapColorMode,
  theme: TreemapTheme
): SunburstLayout {
  const root = hierarchy(data, (d) => d.children)
    .sum((d) => (d.children?.length ? 0 : Math.max(0, d.value)))
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))

  const rings = Math.max(1, root.height)
  // Each depth gets one unit of y, so depth d spans [d, d + 1].
  partition<TreemapNode>().size([TAU, rings + 1])(root)

  const laid = root as HierarchyRectangularNode<TreemapNode>
  const total = laid.value ?? 0
  const hole = Math.max(0, radius) * HOLE_RATIO
  const ring = (Math.max(0, radius) - hole) / rings
  const toRadius = (y: number) => hole + (y - 1) * ring

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

  const types =
    mode === 'type'
      ? typeColoring(
          laid
            .leaves()
            .filter((l) => l.depth > 0 && l.data.kind === 'file' && !specialOf(l.data))
            .map((l) => ({ ext: l.data.ext, value: l.value ?? 0 })),
          theme
        )
      : null

  const arcs: SunburstArc[] = []
  laid.each((node) => {
    if (!node.parent) return
    const r0 = toRadius(node.y0)
    const r1 = toRadius(node.y1)
    if ((node.x1 - node.x0) * r1 < MIN_ARC_PX) return
    const special = specialOf(node.data)
    const isFolder = node.data.kind === 'dir'
    const hasChildren = Boolean(node.children?.length)

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
      // Outer rings fade toward the background so the branch stays readable as one hue.
      fill = mixColors(base, background, Math.min(0.5, 0.14 * (node.depth - 1)))
      subtext = isFolder ? 'Folder' : extLabel(node.data.ext)
    } else if (isFolder) {
      fill = hasChildren
        ? mixColors(foreground, background, Math.max(0.74, 0.86 - 0.04 * (node.depth - 1)))
        : types!.folderTileColor
      subtext = 'Folder'
    } else {
      fill = types!.colorOf(node.data.ext)
      subtext = extLabel(node.data.ext)
    }

    arcs.push({
      a0: node.x0,
      a1: node.x1,
      r0,
      r1,
      node: node.data,
      parentPath: node.parent.data.path,
      depth: node.depth,
      special,
      fill,
      text: readableOn(fill, textChoices),
      subtext
    })
  })

  const folderTiles = laid
    .leaves()
    .filter((l) => l.depth > 0 && l.data.kind === 'dir' && !specialOf(l.data))
    .reduce((sum, l) => sum + (l.value ?? 0), 0)
  const legend = types ? types.legend(folderTiles) : []

  return { arcs, legend, total, hole, ring }
}

function point(r: number, a: number): string {
  return `${round(r * Math.sin(a))} ${round(-r * Math.cos(a))}`
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

/** SVG path for a ring segment centered on the origin. A full turn is drawn as a whole ring. */
export function arcPath(a0: number, a1: number, r0: number, r1: number): string {
  const span = a1 - a0
  if (span >= TAU - 1e-6) {
    // An arc can't start and end on the same point, so a full ring is two halves.
    // The hole runs the other way so the default nonzero fill rule leaves it empty.
    const outer = `M 0 ${round(-r1)} A ${round(r1)} ${round(r1)} 0 1 1 0 ${round(r1)} A ${round(r1)} ${round(r1)} 0 1 1 0 ${round(-r1)} Z`
    if (r0 <= 0) return outer
    return `${outer} M 0 ${round(-r0)} A ${round(r0)} ${round(r0)} 0 1 0 0 ${round(r0)} A ${round(r0)} ${round(r0)} 0 1 0 0 ${round(-r0)} Z`
  }
  const large = span > Math.PI ? 1 : 0
  const R1 = round(r1)
  if (r0 <= 0) return `M 0 0 L ${point(r1, a0)} A ${R1} ${R1} 0 ${large} 1 ${point(r1, a1)} Z`
  const R0 = round(r0)
  return (
    `M ${point(r1, a0)} A ${R1} ${R1} 0 ${large} 1 ${point(r1, a1)} ` +
    `L ${point(r0, a1)} A ${R0} ${R0} 0 ${large} 0 ${point(r0, a0)} Z`
  )
}
