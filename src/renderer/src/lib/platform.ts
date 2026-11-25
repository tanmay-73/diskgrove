/** The file manager command that shows an item in its folder, as each system names it. */
export function revealLabel(platform: string | undefined): string {
  if (platform === 'darwin') return 'Reveal in Finder'
  if (platform === 'win32') return 'Show in Explorer'
  return 'Show in folder'
}
