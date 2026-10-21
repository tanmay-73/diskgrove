// Percentages of the default UI size. Applied as the window zoom factor so
// fixed pixel sizes (row heights, chart labels) scale along with the text.
export const FONT_SCALES = [80, 90, 100, 110, 125, 150] as const

export const DEFAULT_FONT_SCALE = 100

export function isFontScale(value: unknown): value is number {
  return typeof value === 'number' && (FONT_SCALES as readonly number[]).includes(value)
}

export function stepFontScale(current: number, direction: -1 | 0 | 1): number {
  if (direction === 0) return DEFAULT_FONT_SCALE
  const index = FONT_SCALES.indexOf(current as (typeof FONT_SCALES)[number])
  const from = index === -1 ? FONT_SCALES.indexOf(DEFAULT_FONT_SCALE) : index
  const next = Math.min(FONT_SCALES.length - 1, Math.max(0, from + direction))
  return FONT_SCALES[next]
}
