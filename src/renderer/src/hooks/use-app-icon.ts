import { useEffect, useState } from 'react'

// Icons outlive the view: IDs stay the same across refreshes, so coming back draws them at once.
const loaded = new Map<string, string | null>()
const loading = new Map<string, Promise<string | null>>()

function load(id: string): Promise<string | null> {
  let icon = loading.get(id)
  if (!icon) {
    icon = window.diskgrove
      .getAppIcon(id)
      .catch(() => null)
      .then((url) => {
        loaded.set(id, url)
        loading.delete(id)
        return url
      })
    loading.set(id, icon)
  }
  return icon
}

/** The icon of a listed app as an image URL, or null while it loads and when there is none. */
export function useAppIcon(id: string, hasIcon: boolean): string | null {
  const [result, setResult] = useState<{ id: string; url: string | null } | null>(null)

  useEffect(() => {
    if (!hasIcon || loaded.has(id)) return
    let live = true
    void load(id).then((url) => {
      if (live) setResult({ id, url })
    })
    return () => {
      live = false
    }
  }, [id, hasIcon])

  if (!hasIcon) return null
  if (loaded.has(id)) return loaded.get(id) ?? null
  return result?.id === id ? result.url : null
}
