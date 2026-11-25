import { app, nativeImage, type NativeImage } from 'electron'
import { imageType, resolveIcon, type IconFile, type IconSource } from './app-icons'
import { nativePath } from './disk-usage'
import { fs } from './real-fs'

// Twice the 24 px the list draws icons at, for high-density screens.
const ICON_PX = 48
const MAX_CACHED = 1000

const cache = new Map<string, Promise<string | null>>()

/** A PNG data URL of the image, no larger than the list needs. */
function scaled(image: NativeImage): string | null {
  if (image.isEmpty()) return null
  const { width, height } = image.getSize()
  if (Math.max(width, height) <= ICON_PX) return image.toDataURL()
  return image
    .resize(width >= height ? { width: ICON_PX, quality: 'best' } : { height: ICON_PX, quality: 'best' })
    .toDataURL()
}

async function draw(icon: IconFile): Promise<string | null> {
  if (icon.kind === 'file') {
    // The system's icon for the file: an executable's own on Windows, a bundle's on macOS.
    // macOS offers 32 px at most; Windows offers 32 px as large.
    return scaled(await app.getFileIcon(icon.path, { size: process.platform === 'darwin' ? 'normal' : 'large' }))
  }
  const data = await fs.readFile(nativePath(icon.path))
  switch (imageType(icon.path, data)) {
    case 'png':
    case 'jpeg':
      return scaled(nativeImage.createFromBuffer(data))
    // The window decodes icon files itself, picking the largest of the sizes inside.
    case 'ico':
      return `data:image/x-icon;base64,${data.toString('base64')}`
    // An SVG in an <img> runs no scripts and loads nothing else.
    case 'svg':
      return `data:image/svg+xml;base64,${data.toString('base64')}`
    default:
      return null
  }
}

/** An app's icon as a data URL for the window, or null when it has none that can be drawn. */
export function iconDataUrl(source: IconSource): Promise<string | null> {
  const key = JSON.stringify(source)
  let icon = cache.get(key)
  if (!icon) {
    if (cache.size >= MAX_CACHED) cache.clear()
    icon = resolveIcon(source)
      .then((file) => (file ? draw(file) : null))
      .catch(() => null)
    cache.set(key, icon)
  }
  return icon
}
