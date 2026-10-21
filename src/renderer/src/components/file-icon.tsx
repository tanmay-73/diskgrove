import { File, FileArchive, FileAudio, FileCode, FileImage, FileText, FileVideo, Folder, HardDrive } from 'lucide-react'
import { categoryOf, extensionOf } from '@shared/format'
import { cn } from '@/lib/utils'

export function FileGlyph({
  name,
  kind,
  isRoot,
  className
}: {
  name: string
  kind: 'file' | 'dir'
  isRoot?: boolean
  className?: string
}) {
  const cls = cn('size-4 shrink-0', className)
  if (isRoot) return <HardDrive className={cn(cls, 'text-sky-400')} />
  if (kind === 'dir') return <Folder className={cn(cls, 'text-amber-400 fill-amber-400/25')} />
  const cat = categoryOf(extensionOf(name))
  switch (cat) {
    case 'Video':
      return <FileVideo className={cn(cls, 'text-rose-400')} />
    case 'Audio':
      return <FileAudio className={cn(cls, 'text-violet-400')} />
    case 'Images':
      return <FileImage className={cn(cls, 'text-emerald-400')} />
    case 'Archives':
      return <FileArchive className={cn(cls, 'text-orange-400')} />
    case 'Documents':
      return <FileText className={cn(cls, 'text-sky-300')} />
    case 'Code':
      return <FileCode className={cn(cls, 'text-teal-300')} />
    default:
      return <File className={cn(cls, 'text-muted-foreground')} />
  }
}
