import { MAX_PREVIEW_READ } from '@shared/preview'
import type { ReadAt } from '@shared/zip'

// Random access to a scanned file through the main process, split into IPC-sized reads.
export function fileReader(path: string): ReadAt {
  return async (offset, length) => {
    const parts: Uint8Array[] = []
    let total = 0
    while (total < length) {
      const chunk = await window.diskgrove.readFile(path, offset + total, Math.min(MAX_PREVIEW_READ, length - total))
      if (chunk.bytes.length === 0) break
      parts.push(chunk.bytes)
      total += chunk.bytes.length
    }
    if (parts.length === 1) return parts[0]
    const out = new Uint8Array(total)
    let at = 0
    for (const part of parts) {
      out.set(part, at)
      at += part.length
    }
    return out
  }
}
