import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { contrastRatio, layoutTreemap, mixColors, readableOn } from '@shared/treemap-layout'
import type { TreemapTheme } from '@shared/treemap-layout'
import type { TreemapNode } from '@shared/types'

vi.mock('electron', () => ({ shell: { trashItem: vi.fn() } }))
import { isVolumeRoot } from '../src/main/mounts'
import { Scanner } from '../src/main/scanner'

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

describe('treemap colors', () => {
  it('mixes hex colors and picks readable text', () => {
    expect(mixColors('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(mixColors('#fff', '#000', 0)).toBe('#ffffff')
    expect(readableOn('#f5c84c', ['#ffffff', '#101418'])).toBe('#101418')
    expect(readableOn('#1d6fd8', ['#ffffff', '#101418'])).toBe('#ffffff')
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21)
  })
})

describe('layoutTreemap', () => {
  const data = dir('/r', [
    dir('/r/a', [file('/r/a/big.mp4', 600, '.mp4'), file('/r/a/small.txt', 100)]),
    dir('/r/b', [file('/r/b/c.txt', 200), file('/r/b/d.zip', 100, '.zip')]),
    dir('/r/c', [file('/r/c/Makefile', 50, '(none)')])
  ])

  it('keeps every tile inside the canvas and proportional to size', () => {
    const { cells, total } = layoutTreemap(data, 800, 600, 'folder', theme)
    expect(total).toBe(1050)
    for (const c of cells) {
      expect(c.x0).toBeGreaterThanOrEqual(0)
      expect(c.y0).toBeGreaterThanOrEqual(0)
      expect(c.x1).toBeLessThanOrEqual(800)
      expect(c.y1).toBeLessThanOrEqual(600)
    }
    const area = (p: string) => {
      const c = cells.find((x) => x.node.path === p)!
      return (c.x1 - c.x0) * (c.y1 - c.y0)
    }
    expect(area('/r/a')).toBeGreaterThan(area('/r/b'))
    expect(area('/r/a/big.mp4')).toBeGreaterThan(area('/r/a/small.txt') * 3)
  })

  it('gives folder contents the hue of their top-level branch', () => {
    const { cells } = layoutTreemap(data, 800, 600, 'folder', theme)
    const get = (p: string) => cells.find((c) => c.node.path === p)!
    expect(get('/r/a/big.mp4').fill).toBe(mixColors(theme.palette[0], theme.background, 0.1))
    expect(get('/r/b/c.txt').fill).toBe(mixColors(theme.palette[1], theme.background, 0.1))
    expect(get('/r/a').isFrame).toBe(true)
    expect(get('/r/a').hasHeader).toBe(true)
    for (const c of cells) expect(contrastRatio(c.fill, c.text)).toBeGreaterThanOrEqual(4.5)
  })

  it('colors by extension rank and builds a legend in type mode', () => {
    const { cells, legend } = layoutTreemap(data, 800, 600, 'type', theme)
    expect(legend.map((l) => l.label)).toEqual(['.mp4', '.txt', '.zip', 'No extension'])
    expect(legend[1].value).toBe(300)
    const txt = cells.filter((c) => c.node.ext === '.txt')
    expect(new Set(txt.map((c) => c.fill)).size).toBe(1)
    expect(txt[0].fill).toBe(theme.palette[1])
  })
})

describe('Scanner.getTreemap', () => {
  let fixture: string
  let root: string

  beforeEach(async () => {
    fixture = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'diskgrove-test-'))
    root = path.join(fixture, 'scan')
    await fs.mkdir(root)
  })

  afterEach(async () => {
    if (!path.basename(fixture).startsWith('diskgrove-test-')) throw new Error('Unexpected fixture path')
    await fs.rm(fixture, { recursive: true, force: true })
  })

  it('only treats drive and mount roots as volume roots', async () => {
    expect(await isVolumeRoot(path.parse(root).root)).toBe(true)
    expect(await isVolumeRoot(root)).toBe(false)
    expect(await isVolumeRoot(path.join(root, 'missing'))).toBe(false)
  })

  it('ranks files and folders together and accounts for the remainder', async () => {
    await fs.writeFile(path.join(root, 'huge.bin'), Buffer.alloc(50_000))
    for (let i = 0; i < 60; i++) {
      const sub = path.join(root, `dir-${i}`)
      await fs.mkdir(sub)
      await fs.writeFile(path.join(sub, 'f.txt'), Buffer.alloc(100))
    }
    const scanner = new Scanner()
    await scanner.start(root)
    scanner.finish({ total: 0, free: 0 })

    const tree = scanner.getTreemap(root, 2, 0)!
    const names = tree.children!.map((c) => c.name)
    expect(names[0]).toBe('huge.bin')
    expect(names).toContain('Other')
    const sum = tree.children!.reduce((s, c) => s + c.value, 0)
    expect(sum).toBe(tree.value)
  })
})
