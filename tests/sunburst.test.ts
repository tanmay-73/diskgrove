import { describe, expect, it } from 'vitest'
import { HOLE_RATIO, arcPath, layoutSunburst } from '@shared/sunburst-layout'
import { FREE_SPACE_PATH, contrastRatio, mixColors } from '@shared/treemap-layout'
import type { TreemapTheme } from '@shared/treemap-layout'
import type { TreemapNode } from '@shared/types'

const theme: TreemapTheme = {
  palette: ['#4c9bff', '#3dd68c', '#f5c84c', '#ff8a5b'],
  background: '#0c1017',
  foreground: '#e8eef6',
  muted: '#1a2230'
}

function file(p: string, value: number, ext = '.txt'): TreemapNode {
  return { path: p, name: p.split('/').pop()!, kind: 'file', value, ext }
}

function dir(p: string, children: TreemapNode[]): TreemapNode {
  return {
    path: p,
    name: p.split('/').pop()!,
    kind: 'dir',
    value: children.reduce((s, c) => s + c.value, 0),
    ext: '',
    children
  }
}

describe('layoutSunburst', () => {
  const data = dir('/r', [
    dir('/r/a', [file('/r/a/big.mp4', 600, '.mp4'), file('/r/a/small.txt', 100)]),
    dir('/r/b', [file('/r/b/c.txt', 200), file('/r/b/d.zip', 100, '.zip')]),
    dir('/r/c', [file('/r/c/Makefile', 50, '(none)')])
  ])
  const get = (arcs: ReturnType<typeof layoutSunburst>['arcs'], p: string) => arcs.find((a) => a.node.path === p)!

  it('splits the full turn in proportion to size, ring by ring', () => {
    const { arcs, total, hole, ring } = layoutSunburst(data, 200, 'folder', theme)
    expect(total).toBe(1050)
    expect(hole).toBeCloseTo(200 * HOLE_RATIO)
    expect(ring).toBeCloseTo((200 - hole) / 2)

    const top = arcs.filter((a) => a.depth === 1)
    expect(top.map((a) => a.node.path)).toEqual(['/r/a', '/r/b', '/r/c'])
    expect(top[0].a0).toBeCloseTo(0)
    expect(top[top.length - 1].a1).toBeCloseTo(Math.PI * 2)
    const span = (p: string) => get(arcs, p).a1 - get(arcs, p).a0
    expect(span('/r/a') / span('/r/b')).toBeCloseTo(700 / 300)

    for (const a of arcs) {
      expect(a.r0).toBeCloseTo(hole + (a.depth - 1) * ring)
      expect(a.r1).toBeCloseTo(a.r0 + ring)
      expect(a.r1).toBeLessThanOrEqual(200 + 1e-9)
    }
    // Children sit inside their parent's angle.
    const parent = get(arcs, '/r/a')
    for (const p of ['/r/a/big.mp4', '/r/a/small.txt']) {
      expect(get(arcs, p).a0).toBeGreaterThanOrEqual(parent.a0 - 1e-9)
      expect(get(arcs, p).a1).toBeLessThanOrEqual(parent.a1 + 1e-9)
    }
  })

  it('gives folder contents the hue of their top-level branch', () => {
    const { arcs } = layoutSunburst(data, 200, 'folder', theme)
    expect(get(arcs, '/r/a').fill).toBe(theme.palette[0])
    expect(get(arcs, '/r/a/big.mp4').fill).toBe(mixColors(theme.palette[0], theme.background, 0.14))
    expect(get(arcs, '/r/b/c.txt').fill).toBe(mixColors(theme.palette[1], theme.background, 0.14))
    expect(get(arcs, '/r/c/Makefile').subtext).toBe('No extension')
    for (const a of arcs) expect(contrastRatio(a.fill, a.text)).toBeGreaterThanOrEqual(4.5)
  })

  it('colors by extension rank and builds a legend in type mode', () => {
    const { arcs, legend } = layoutSunburst(data, 200, 'type', theme)
    expect(legend.map((l) => l.label)).toEqual(['.mp4', '.txt', '.zip', 'No extension'])
    const txt = arcs.filter((a) => a.node.ext === '.txt')
    expect(new Set(txt.map((a) => a.fill)).size).toBe(1)
    expect(txt[0].fill).toBe(theme.palette[1])
  })

  it('marks free space and skips slices too thin to see', () => {
    const tiny = file('/r/tiny.txt', 0.001)
    const withFree = { ...data, children: [...data.children!, tiny, file(FREE_SPACE_PATH, 1050, '')] }
    const { arcs } = layoutSunburst(withFree, 200, 'folder', theme)
    expect(get(arcs, FREE_SPACE_PATH).special).toBe('free')
    expect(get(arcs, FREE_SPACE_PATH).fill).toBe(theme.muted)
    expect(arcs.some((a) => a.node.path === '/r/tiny.txt')).toBe(false)
  })
})

describe('arcPath', () => {
  it('draws a ring segment with inner and outer arcs', () => {
    expect(arcPath(0, Math.PI / 2, 10, 20)).toBe('M 0 -20 A 20 20 0 0 1 20 0 L 10 0 A 10 10 0 0 0 0 -10 Z')
  })

  it('uses the large-arc flag past half a turn', () => {
    expect(arcPath(0, Math.PI * 1.5, 10, 20)).toContain('A 20 20 0 1 1')
  })

  it('draws a full turn as a closed ring with a hole', () => {
    const d = arcPath(0, Math.PI * 2, 10, 20)
    expect(d).toBe('M 0 -20 A 20 20 0 1 1 0 20 A 20 20 0 1 1 0 -20 Z M 0 -10 A 10 10 0 1 0 0 10 A 10 10 0 1 0 0 -10 Z')
  })
})
