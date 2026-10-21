export const THEME_MODES = [
  'system',
  'dark',
  'light',
  'github-dark',
  'github-light',
  'github-dimmed',
  'one-dark',
  'solarized-dark',
  'solarized-light',
  'dracula',
  'nord',
  'tokyo-night',
  'monokai',
  'catppuccin-mocha',
  'catppuccin-latte',
  'gruvbox-dark',
  'gruvbox-light'
] as const

export type ThemeMode = (typeof THEME_MODES)[number]

export type ThemeAppearance = 'system' | 'light' | 'dark'

export interface ThemeOption {
  id: ThemeMode
  label: string
  appearance: ThemeAppearance
  group: 'Default' | 'Dark' | 'Light'
  swatch: string
}

export const THEME_OPTIONS: ThemeOption[] = [
  { id: 'system', label: 'System', appearance: 'system', group: 'Default', swatch: '#64748b' },
  { id: 'dark', label: 'Dark', appearance: 'dark', group: 'Default', swatch: '#0c1017' },
  { id: 'light', label: 'Light', appearance: 'light', group: 'Default', swatch: '#f4f6fa' },
  { id: 'github-dark', label: 'GitHub Dark', appearance: 'dark', group: 'Dark', swatch: '#0d1117' },
  { id: 'github-dimmed', label: 'GitHub Dimmed', appearance: 'dark', group: 'Dark', swatch: '#22272e' },
  { id: 'one-dark', label: 'One Dark', appearance: 'dark', group: 'Dark', swatch: '#282c34' },
  { id: 'solarized-dark', label: 'Solarized Dark', appearance: 'dark', group: 'Dark', swatch: '#002b36' },
  { id: 'dracula', label: 'Dracula', appearance: 'dark', group: 'Dark', swatch: '#282a36' },
  { id: 'nord', label: 'Nord', appearance: 'dark', group: 'Dark', swatch: '#2e3440' },
  { id: 'tokyo-night', label: 'Tokyo Night', appearance: 'dark', group: 'Dark', swatch: '#1a1b26' },
  { id: 'monokai', label: 'Monokai', appearance: 'dark', group: 'Dark', swatch: '#272822' },
  { id: 'catppuccin-mocha', label: 'Catppuccin Mocha', appearance: 'dark', group: 'Dark', swatch: '#1e1e2e' },
  { id: 'gruvbox-dark', label: 'Gruvbox Dark', appearance: 'dark', group: 'Dark', swatch: '#282828' },
  { id: 'github-light', label: 'GitHub Light', appearance: 'light', group: 'Light', swatch: '#ffffff' },
  { id: 'solarized-light', label: 'Solarized Light', appearance: 'light', group: 'Light', swatch: '#fdf6e3' },
  { id: 'catppuccin-latte', label: 'Catppuccin Latte', appearance: 'light', group: 'Light', swatch: '#eff1f5' },
  { id: 'gruvbox-light', label: 'Gruvbox Light', appearance: 'light', group: 'Light', swatch: '#fbf1c7' }
]

const THEME_MODE_SET = new Set<string>(THEME_MODES)

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && THEME_MODE_SET.has(value)
}

export function resolveTheme(theme: ThemeMode, prefersDark: boolean): Exclude<ThemeMode, 'system'> {
  if (theme === 'system') return prefersDark ? 'dark' : 'light'
  return theme
}

export function themeIsDark(theme: ThemeMode, prefersDark = false): boolean {
  const resolved = resolveTheme(theme, prefersDark)
  return THEME_OPTIONS.find((option) => option.id === resolved)?.appearance === 'dark'
}
