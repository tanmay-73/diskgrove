/// <reference types="vite/client" />
import type { DiskGroveAPI } from '@shared/types'

declare global {
  // From package.json, set by electron.vite.config.ts.
  const __APP_VERSION__: string

  interface Window {
    diskgrove: DiskGroveAPI
  }
}

export {}
