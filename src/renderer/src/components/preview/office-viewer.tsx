import { useEffect, useState, type ReactNode } from 'react'
import { formatNumber } from '@shared/format'
import { ScrollArea } from '@/components/ui/scroll-area'
import { fileReader } from '@/lib/file-reader'
import {
  readDocx,
  readOfficeProperties,
  readSharedStrings,
  readSheet,
  readSheetList,
  readSlides,
  type DocBlock,
  type ParagraphStyle,
  type SheetRef
} from '@/lib/office'
import { ZipArchive } from '@shared/zip'
import { cn } from '@/lib/utils'
import { IconPreview, Loading, Note, TableView, useAsyncValue, type InfoRow, type ViewerProps } from './viewers'

type OfficeKind = 'docx' | 'xlsx' | 'pptx'

const PARAGRAPH_CLASS: Record<ParagraphStyle, string> = {
  title: 'mb-3 text-[20px] font-semibold leading-tight',
  heading1: 'mt-3 mb-1.5 text-[16px] font-semibold leading-snug',
  heading2: 'mt-2.5 mb-1 text-[14px] font-semibold leading-snug',
  heading3: 'mt-2 mb-1 text-[12.5px] font-semibold',
  body: 'mb-1.5 text-[11.5px] leading-relaxed'
}

// The page fills the panel height even for short documents.
function Paper({ children }: { children: ReactNode }) {
  return (
    <ScrollArea
      className="h-full rounded-md border bg-muted/40"
      viewportClassName="[&>div]:flex! [&>div]:min-h-full [&>div]:flex-col [&>div]:p-3"
    >
      <div className="mx-auto w-full max-w-[42rem] flex-1 select-text rounded-sm bg-white px-8 py-7 text-neutral-900 shadow-md">
        {children}
      </div>
    </ScrollArea>
  )
}

function DocumentView({ blocks, truncated }: { blocks: DocBlock[]; truncated: boolean }) {
  return (
    <Paper>
      {blocks.map((block, i) => {
        if (block.type === 'table') {
          return (
            <table key={i} className="my-2 w-full border-collapse text-[10.5px]">
              <tbody>
                {block.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, c) => (
                      <td key={c} className="whitespace-pre-wrap border border-neutral-300 px-1.5 py-1 align-top">
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }
        if (block.runs.length === 0) return <div key={i} className="h-2" />
        const content = block.runs.map((run, r) => (
          <span
            key={r}
            className={cn(
              run.bold && 'font-semibold',
              run.italic && 'italic',
              run.underline && 'underline',
              run.strike && 'line-through'
            )}
          >
            {run.text}
          </span>
        ))
        if (block.listLevel !== null) {
          return (
            <div
              key={i}
              className={cn(PARAGRAPH_CLASS.body, 'flex gap-2 whitespace-pre-wrap')}
              style={{ paddingLeft: `${0.75 + block.listLevel * 1.25}rem` }}
            >
              <span aria-hidden>•</span>
              <span>{content}</span>
            </div>
          )
        }
        return (
          <p key={i} className={cn(PARAGRAPH_CLASS[block.style], 'whitespace-pre-wrap')}>
            {content}
          </p>
        )
      })}
      {truncated ? (
        <p className="mt-3 text-[11px] text-neutral-500">Preview shows the beginning of the document.</p>
      ) : null}
    </Paper>
  )
}

function WorkbookView({ zip, sheets, shared }: { zip: ZipArchive; sheets: SheetRef[]; shared: string[] }) {
  const [index, setIndex] = useState(0)
  const sheet = sheets[index]
  const state = useAsyncValue(() => readSheet(zip, sheet, shared), sheet.path)
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-md border bg-background">
      {state.status === 'loading' ? (
        <div className="min-h-0 flex-1">
          <Loading />
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1 select-text">
          {state.status === 'error' ? <p className="p-3 text-xs text-muted-foreground">{state.message}</p> : null}
          {state.status === 'ready' ? (
            state.value.rows.length ? (
              <TableView rows={state.value.rows} header={false} />
            ) : (
              <p className="p-3 text-xs text-muted-foreground">This sheet is empty.</p>
            )
          ) : null}
        </ScrollArea>
      )}
      {state.status === 'ready' && state.value.truncated ? <Note>Showing the top-left part of the sheet</Note> : null}
      {sheets.length > 1 ? (
        <ScrollArea orientation="horizontal" className="shrink-0 border-t bg-muted/40">
          <div className="flex w-max min-w-full gap-0.5 p-1">
            {sheets.map((s, i) => (
              <button
                key={s.path}
                type="button"
                className={cn(
                  'shrink-0 rounded px-2 py-0.5 text-[11px] transition-colors',
                  i === index ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'
                )}
                onClick={() => setIndex(i)}
              >
                {s.name}
              </button>
            ))}
          </div>
        </ScrollArea>
      ) : null}
    </div>
  )
}

function SlidesView({ slides, total }: { slides: string[][]; total: number }) {
  return (
    <ScrollArea className="h-full rounded-md border bg-muted/40">
      <div className="space-y-3 p-3">
        {slides.map((lines, i) => (
          <figure key={i} className="space-y-1">
            <figcaption className="text-[10px] text-muted-foreground">Slide {i + 1}</figcaption>
            <div className="aspect-video overflow-hidden rounded-sm bg-white p-4 text-neutral-900 shadow-md select-text">
              {lines.length === 0 ? (
                <p className="text-[11px] text-neutral-400">No text on this slide</p>
              ) : (
                <>
                  <p className="mb-2 text-[14px] font-semibold leading-snug">{lines[0]}</p>
                  <ul className="space-y-0.5 text-[11px] leading-snug">
                    {lines.slice(1, 12).map((line, l) => (
                      <li key={l}>{line}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </figure>
        ))}
        {total > slides.length ? (
          <p className="text-center text-[11px] text-muted-foreground">
            Showing {formatNumber(slides.length)} of {formatNumber(total)} slides
          </p>
        ) : null}
      </div>
    </ScrollArea>
  )
}

async function loadOffice(item: ViewerProps['item'], kind: OfficeKind) {
  const zip = await ZipArchive.open(fileReader(item.path), item.size)
  const properties = await readOfficeProperties(zip).catch((): InfoRow[] => [])
  if (kind === 'docx') return { kind, properties, document: await readDocx(zip) } as const
  if (kind === 'xlsx') {
    const [sheets, shared] = await Promise.all([readSheetList(zip), readSharedStrings(zip)])
    return { kind, properties, zip, sheets, shared } as const
  }
  return { kind, properties, presentation: await readSlides(zip) } as const
}

export function OfficeViewer({ item, kind, onDetails }: ViewerProps & { kind: OfficeKind }) {
  const state = useAsyncValue(() => loadOffice(item, kind), `${item.path}:${item.mtime}`)
  useEffect(() => {
    if (state.status !== 'ready') return
    const rows = [...state.value.properties]
    if (state.value.kind === 'xlsx') rows.push(['Sheets', formatNumber(state.value.sheets.length)])
    onDetails(rows)
  }, [state, onDetails])

  if (state.status === 'loading') return <Loading />
  if (state.status === 'error') return <IconPreview item={item} message={state.message} />
  const value = state.value
  if (value.kind === 'docx') return <DocumentView {...value.document} />
  if (value.kind === 'xlsx') {
    if (value.sheets.length === 0) return <IconPreview item={item} message="This workbook has no sheets." />
    return <WorkbookView zip={value.zip} sheets={value.sheets} shared={value.shared} />
  }
  return <SlidesView {...value.presentation} />
}
