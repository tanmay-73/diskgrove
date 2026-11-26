import { useState, type FormEvent } from 'react'
import { FolderOpen, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useScan } from '@/scan-context'

// Offered until they are on the list: the two folders people most often want out of a project scan.
const SUGGESTED = ['node_modules', '.git']

/** Edits the names, patterns and folders that scans leave out. Changes are saved as they are made. */
export function ExcludeDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { settings, applySettings, showToast } = useScan()
  const [draft, setDraft] = useState('')
  const list = settings.exclude

  const save = (next: string[]) =>
    applySettings({ exclude: next }).catch(() => showToast('Could not save the excluded items'))

  const add = (value: string) => {
    const pattern = value.trim()
    if (!pattern) return
    if (!list.includes(pattern)) void save([...list, pattern])
    setDraft('')
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    add(draft)
  }

  const browse = async () => {
    const folder = await window.diskgrove.pickFolder()
    if (folder) add(folder)
  }

  const suggestions = SUGGESTED.filter((name) => !list.includes(name))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Excluded from scans</DialogTitle>
          <DialogDescription>
            A name such as <code>node_modules</code> or a pattern such as <code>*.tmp</code> leaves out every file and
            folder it matches. A full path leaves out just that folder. Changes apply to the next scan.
          </DialogDescription>
        </DialogHeader>

        <form className="flex gap-1.5" onSubmit={onSubmit}>
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Name, pattern or path"
            aria-label="Name, pattern or path to exclude"
            spellCheck={false}
            autoFocus
          />
          <Button type="submit" variant="secondary" disabled={!draft.trim()}>
            <Plus />
            Add
          </Button>
          <Button type="button" variant="outline" onClick={() => void browse()}>
            <FolderOpen />
            Folder…
          </Button>
        </form>

        {suggestions.length ? (
          <div className="-mt-2 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            Common:
            {suggestions.map((name) => (
              <Button key={name} variant="ghost" size="sm" className="font-mono" onClick={() => add(name)}>
                <Plus />
                {name}
              </Button>
            ))}
          </div>
        ) : null}

        {list.length ? (
          <ScrollArea orientation="vertical" className="max-h-60 rounded-md border">
            <ul className="p-1">
              {list.map((pattern) => (
                <li key={pattern} className="flex items-center gap-2 rounded-sm py-0.5 pl-2 pr-0.5 hover:bg-accent">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs" title={pattern}>
                    {pattern}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 shrink-0"
                    aria-label={`Stop excluding ${pattern}`}
                    onClick={() => void save(list.filter((item) => item !== pattern))}
                  >
                    <X className="size-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          </ScrollArea>
        ) : (
          <p className="rounded-md border border-dashed py-4 text-center text-sm text-muted-foreground">
            Scans include everything.
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}
