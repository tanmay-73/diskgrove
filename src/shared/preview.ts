import { extensionOf } from './format'

export type PreviewKind =
  'image' | 'video' | 'audio' | 'pdf' | 'csv' | 'docx' | 'xlsx' | 'pptx' | 'zip' | 'text' | 'unknown'

export const MEDIA_SCHEME = 'diskgrove-media'

// Largest single read the renderer may request over IPC.
export const MAX_PREVIEW_READ = 16 * 1024 * 1024

// Formats Chromium decodes natively, mapped to the type the media protocol serves.
const MEDIA_TYPES: Record<string, { kind: 'image' | 'video' | 'audio'; mime: string }> = {
  '.jpg': { kind: 'image', mime: 'image/jpeg' },
  '.jpeg': { kind: 'image', mime: 'image/jpeg' },
  '.jfif': { kind: 'image', mime: 'image/jpeg' },
  '.png': { kind: 'image', mime: 'image/png' },
  '.apng': { kind: 'image', mime: 'image/apng' },
  '.gif': { kind: 'image', mime: 'image/gif' },
  '.webp': { kind: 'image', mime: 'image/webp' },
  '.avif': { kind: 'image', mime: 'image/avif' },
  '.bmp': { kind: 'image', mime: 'image/bmp' },
  '.ico': { kind: 'image', mime: 'image/x-icon' },
  '.svg': { kind: 'image', mime: 'image/svg+xml' },
  '.mp4': { kind: 'video', mime: 'video/mp4' },
  '.m4v': { kind: 'video', mime: 'video/mp4' },
  '.mov': { kind: 'video', mime: 'video/mp4' },
  '.webm': { kind: 'video', mime: 'video/webm' },
  '.mkv': { kind: 'video', mime: 'video/webm' },
  '.ogv': { kind: 'video', mime: 'video/ogg' },
  '.mp3': { kind: 'audio', mime: 'audio/mpeg' },
  '.wav': { kind: 'audio', mime: 'audio/wav' },
  '.ogg': { kind: 'audio', mime: 'audio/ogg' },
  '.oga': { kind: 'audio', mime: 'audio/ogg' },
  '.opus': { kind: 'audio', mime: 'audio/ogg' },
  '.flac': { kind: 'audio', mime: 'audio/flac' },
  '.m4a': { kind: 'audio', mime: 'audio/mp4' },
  '.aac': { kind: 'audio', mime: 'audio/aac' },
  '.weba': { kind: 'audio', mime: 'audio/webm' }
}

const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.text',
  '.md',
  '.markdown',
  '.log',
  '.json',
  '.jsonc',
  '.xml',
  '.yml',
  '.yaml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.env',
  '.properties',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.py',
  '.java',
  '.kt',
  '.swift',
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
  '.go',
  '.rs',
  '.php',
  '.rb',
  '.lua',
  '.r',
  '.dart',
  '.scala',
  '.sql',
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.less',
  '.vue',
  '.svelte',
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.ps1',
  '.bat',
  '.cmd',
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
  '.srt',
  '.vtt',
  '.tex',
  '.rst'
])

export function previewKindOf(name: string): PreviewKind {
  const ext = extensionOf(name)
  const media = MEDIA_TYPES[ext]
  if (media) return media.kind
  if (ext === '.pdf') return 'pdf'
  if (ext === '.csv' || ext === '.tsv') return 'csv'
  if (ext === '.docx' || ext === '.docm') return 'docx'
  if (ext === '.xlsx' || ext === '.xlsm') return 'xlsx'
  if (ext === '.pptx' || ext === '.pptm') return 'pptx'
  if (ext === '.zip') return 'zip'
  if (TEXT_EXTENSIONS.has(ext)) return 'text'
  return 'unknown'
}

export function mediaTypeOf(name: string): string | null {
  return MEDIA_TYPES[extensionOf(name)]?.mime ?? null
}

// Bytes needed by sniffMediaType.
export const MEDIA_SNIFF_BYTES = 16

function ascii(bytes: Uint8Array, start: number, text: string): boolean {
  for (let i = 0; i < text.length; i++) if (bytes[start + i] !== text.charCodeAt(i)) return false
  return true
}

// Audio and video files are often saved under the wrong extension (an MP4 named .mp3, say),
// and media is served with nosniff, so the container is read from the file's first bytes.
// Keeps the extension's audio/video family; falls back to the extension's type when unrecognised.
export function sniffMediaType(head: Uint8Array, fallback: string): string {
  const family = fallback.startsWith('video/') ? 'video' : fallback.startsWith('audio/') ? 'audio' : null
  if (!family) return fallback
  if (ascii(head, 4, 'ftyp')) return `${family}/mp4`
  if (ascii(head, 0, 'OggS')) return `${family}/ogg`
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return `${family}/webm`
  if (ascii(head, 0, 'RIFF') && ascii(head, 8, 'WAVE')) return 'audio/wav'
  if (ascii(head, 0, 'fLaC')) return 'audio/flac'
  if (ascii(head, 0, 'ID3')) return 'audio/mpeg'
  if (head[0] === 0xff && (head[1] & 0xf0) === 0xf0 && (head[1] & 0x06) === 0) return 'audio/aac'
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return 'audio/mpeg'
  return fallback
}

export function mediaUrl(path: string, version: number): string {
  return `${MEDIA_SCHEME}://file/?path=${encodeURIComponent(path)}&v=${Math.trunc(version)}`
}
