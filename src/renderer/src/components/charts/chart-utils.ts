import { useEffect, useMemo, useState } from 'react'
import type { RefObject } from 'react'
import { FREE_SPACE_PATH } from '@shared/treemap-layout'
import type { TreemapColorMode, TreemapTheme } from '@shared/treemap-layout'
import type { NodeSummary, TreemapNode } from '@shared/types'
import { cssVar, mutedFill, themePalette } from '@/lib/palette'
import { useScan } from '@/scan-context'

export const EMPTY_NODE: TreemapNode = { path: '', name: '', kind: 'dir', value: 0, ext: '' }

export function loadColorMode(key: string): TreemapColorMode {
  try {
    return localStorage.getItem(key) === 'type' ? 'type' : 'folder'
  } catch {
    return 'folder'
  }
}

export function saveColorMode(key: string, mode: TreemapColorMode): void {
  try {
    localStorage.setItem(key, mode)
  } catch {
    // Preference just won't persist.
  }
}

/** Color mode kept in localStorage under `key`. */
export function useColorMode(key: string): [TreemapColorMode, (mode: TreemapColorMode) => void] {
  const [mode, setMode] = useState<TreemapColorMode>(() => loadColorMode(key))
  const change = (next: TreemapColorMode) => {
    setMode(next)
    saveColorMode(key, next)
  }
  return [mode, change]
}

function readTheme(): TreemapTheme {
  return {
    palette: themePalette(),
    background: cssVar('--background', '#0c1017'),
    foreground: cssVar('--foreground', '#e8eef6'),
    muted: mutedFill()
  }
}

/** Bumps whenever the app theme flips so colors are re-read from CSS. */
function useThemeVersion(): number {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const observer = new MutationObserver(() => setVersion((v) => v + 1))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] })
    return () => observer.disconnect()
  }, [])
  return version
}

/** Chart colors from the current theme, re-read whenever the theme flips. */
export function useChartTheme(): TreemapTheme {
  const themeVersion = useThemeVersion()
  return useMemo(readTheme, [themeVersion])
}

/** The chart tree for the selected folder, with free space added at a volume root if enabled. */
export function useChartData(): TreemapNode | null {
  const { treemap: data, selectedPath, complete, settings } = useScan()
  return useMemo(() => {
    if (!data) return null
    const atRoot = Boolean(complete && selectedPath && selectedPath === complete.rootPath)
    if (settings.showFreeSpace && atRoot && complete?.isVolumeRoot && complete.freeSpace > 0) {
      return {
        ...data,
        children: [
          ...(data.children ?? []),
          {
            path: FREE_SPACE_PATH,
            name: 'Free space',
            kind: 'file' as const,
            value: complete.freeSpace,
            ext: ''
          }
        ]
      }
    }
    return data
  }, [data, settings.showFreeSpace, complete, selectedPath])
}

let measureCtx: CanvasRenderingContext2D | null = null
let fontFamily = ''

export function textWidth(text: string, font: string): number {
  if (!measureCtx) {
    measureCtx = document.createElement('canvas').getContext('2d')
    fontFamily = getComputedStyle(document.body).fontFamily || 'sans-serif'
  }
  if (!measureCtx) return text.length * 7
  measureCtx.font = `${font} ${fontFamily}`
  return measureCtx.measureText(text).width
}

/** Longest prefix of `text` (with an ellipsis) that fits in `max` pixels. */
export function fitText(text: string, max: number, font: string): string {
  if (max <= 0) return ''
  if (textWidth(text, font) <= max) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (textWidth(`${text.slice(0, mid)}…`, font) <= max) lo = mid
    else hi = mid - 1
  }
  return lo >= 2 ? `${text.slice(0, lo).trimEnd()}…` : ''
}

export function toSummary(node: TreemapNode, parentPath: string | null): NodeSummary {
  return {
    path: node.path,
    name: node.name,
    kind: node.kind,
    size: node.value,
    allocated: node.value,
    mtime: 0,
    atime: 0,
    ctime: 0,
    fileCount: 0,
    folderCount: 0,
    ext: node.ext,
    parentPath,
    hasSubdirs: Boolean(node.children?.some((c) => c.kind === 'dir'))
  }
}

/** Measures an element's content box, ignoring sizes too small to draw in. */
export function useElementSize(ref: RefObject<HTMLElement | null>): { w: number; h: number } {
  const [size, setSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const w = el.clientWidth
      const h = el.clientHeight
      if (w >= 16 && h >= 16) setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }))
    }
    measure()
    const frame = requestAnimationFrame(measure)
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
    }
  }, [ref])
  return size
}
