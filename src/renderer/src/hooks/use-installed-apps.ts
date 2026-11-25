import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppsProgress, InstalledApp } from '@shared/types'

export interface InstalledApps {
  apps: InstalledApp[]
  /** The latest progress of a listing, kept after it ends. */
  progress: AppsProgress | null
  /** The list is being made or measured. */
  busy: boolean
  stopping: boolean
  /** Measuring was stopped, so some sizes are missing. */
  cancelled: boolean
  error: string | null
  refresh: () => void
  stop: () => void
}

/**
 * The installed apps and their sizes. The main process keeps the last list and runs one listing at a
 * time, so leaving the view and coming back shows the same list, or the listing still running.
 */
export function useInstalledApps(): InstalledApps {
  const [apps, setApps] = useState<InstalledApp[]>([])
  const [progress, setProgress] = useState<AppsProgress | null>(null)
  const [busy, setBusy] = useState(true)
  const [stopping, setStopping] = useState(false)
  const [cancelled, setCancelled] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const request = useRef(0)

  const load = useCallback(async (refresh: boolean) => {
    const id = ++request.current
    setBusy(true)
    setError(null)
    try {
      const result = await window.diskgrove.listApps(refresh)
      if (id !== request.current) return
      setApps(result.apps)
      setCancelled(result.cancelled)
    } catch (err) {
      if (id === request.current) setError(err instanceof Error ? err.message : 'Could not list the installed apps')
    } finally {
      if (id === request.current) {
        setBusy(false)
        setStopping(false)
      }
    }
  }, [])

  useEffect(() => {
    const off = window.diskgrove.onAppsProgress((p) => {
      setProgress(p)
      // A refresh keeps showing the previous list until the new one has been made.
      if (p.phase === 'listing') return
      setApps(p.apps)
      setCancelled(p.cancelled)
    })
    void load(false)
    return off
  }, [load])

  const refresh = useCallback(() => void load(true), [load])

  const stop = useCallback(() => {
    setStopping(true)
    window.diskgrove.cancelApps().catch(() => setStopping(false))
  }, [])

  return { apps, progress, busy, stopping, cancelled, error, refresh, stop }
}
