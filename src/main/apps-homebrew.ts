import path from 'node:path'
import type { AppEntry } from './apps'
import { forEachConcurrent } from './concurrency'
import { fs } from './real-fs'

const MAX_RECEIPT_BYTES = 1024 * 1024

/** Where Homebrew installs on macOS (Apple silicon, then Intel) and on Linux. */
export function homebrewPrefixes(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): string[] {
  const own = env.HOMEBREW_PREFIX?.startsWith('/') ? [env.HOMEBREW_PREFIX] : []
  const defaults =
    platform === 'darwin'
      ? ['/opt/homebrew', '/usr/local']
      : ['/home/linuxbrew/.linuxbrew', path.posix.join(home, '.linuxbrew')]
  return [...new Set([...own, ...defaults].map((p) => path.posix.normalize(p)))]
}

export interface Receipt {
  /** Asked for by name, rather than installed as another formula's dependency. */
  onRequest: boolean
  installedAt: number
}

/** The fields of a formula's INSTALL_RECEIPT.json that say why and when it was installed. */
export function parseReceipt(json: string): Receipt | null {
  try {
    const data = JSON.parse(json) as { installed_on_request?: unknown; time?: unknown }
    const time = Number(data.time)
    return {
      onRequest: data.installed_on_request === true,
      installedAt: Number.isFinite(time) && time > 0 ? time * 1000 : 0
    }
  } catch {
    return null
  }
}

/**
 * Formulae installed on request, each with every version kept in its Cellar folder. Dependencies
 * are left out, as package managers' libraries are on Linux: removing them is Homebrew's business.
 * Casks are not listed here: they move their apps into Applications, where they are found.
 */
export async function discoverHomebrew(prefixes: string[]): Promise<AppEntry[]> {
  const apps: AppEntry[] = []
  const seen = new Set<string>()
  for (const prefix of prefixes) {
    const cellar = path.posix.join(prefix, 'Cellar')
    let real: string
    let names: string[]
    try {
      real = await fs.realpath(cellar)
      names = await fs.readdir(cellar)
    } catch {
      continue
    }
    if (seen.has(real)) continue
    seen.add(real)
    await forEachConcurrent(
      names.filter((name) => !name.startsWith('.')),
      8,
      async (name) => {
        const folder = path.posix.join(cellar, name)
        let versions: string[]
        try {
          versions = (await fs.readdir(folder, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
            .map((entry) => entry.name)
        } catch {
          return
        }
        if (!versions.length) return
        let newest: { version: string; receipt: Receipt | null } | null = null
        let onRequest = false
        for (const version of versions) {
          const file = path.posix.join(folder, version, 'INSTALL_RECEIPT.json')
          const receipt = await fs
            .stat(file)
            .then((s) => (s.isFile() && s.size <= MAX_RECEIPT_BYTES ? fs.readFile(file, 'utf8') : null))
            .then((json) => (json === null ? null : parseReceipt(json)))
            .catch(() => null)
          // A version without a receipt was poured by hand or by an old Homebrew: count it as asked for.
          if (!receipt || receipt.onRequest) onRequest = true
          const at = receipt?.installedAt ?? 0
          if (!newest || at > (newest.receipt?.installedAt ?? 0)) newest = { version, receipt }
        }
        if (!onRequest || !newest) return
        apps.push({
          name,
          version: newest.version,
          publisher: '',
          source: 'homebrew',
          footprint: { kind: 'folder', path: folder },
          estimate: null,
          installedAt: newest.receipt?.installedAt ?? 0,
          icon: null
        })
      }
    )
  }
  return apps
}
