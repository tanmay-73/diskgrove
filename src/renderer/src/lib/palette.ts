const FALLBACK = [
  '#4c9bff',
  '#3dd68c',
  '#f5c84c',
  '#ff8a5b',
  '#a78bfa',
  '#f071a0',
  '#2ec4b6',
  '#e07a5f',
  '#81b29a',
  '#e9c46a',
  '#6c8cff',
  '#ff6b6b'
]

export function cssVar(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

export function themePalette(): string[] {
  if (typeof document === 'undefined') return FALLBACK
  const style = getComputedStyle(document.documentElement)
  const colors: string[] = []
  for (let i = 1; i <= 12; i++) {
    const value = style.getPropertyValue(`--chart-${i}`).trim()
    if (value) colors.push(value)
  }
  return colors.length >= 5 ? colors : FALLBACK
}

export function colorAt(i: number): string {
  const palette = themePalette()
  return palette[i % palette.length]
}

export function hashColor(input: string): string {
  const palette = themePalette()
  let h = 0
  for (let i = 0; i < input.length; i++) h = (h * 31 + input.charCodeAt(i)) >>> 0
  return palette[h % palette.length]
}

export function mutedFill(): string {
  return cssVar('--muted', '#2a3546')
}

export function borderFill(): string {
  return cssVar('--border', '#3a4558')
}
