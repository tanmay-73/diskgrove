// Text-level previews of Office Open XML documents. The output is plain data
// rendered by React, so document content never reaches the DOM as HTML.
import type { ZipArchive } from '@shared/zip'

export interface DocRun {
  text: string
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
}

export type ParagraphStyle = 'title' | 'heading1' | 'heading2' | 'heading3' | 'body'

export type DocBlock =
  | { type: 'paragraph'; style: ParagraphStyle; listLevel: number | null; runs: DocRun[] }
  | { type: 'table'; rows: string[][] }

export interface SheetRef {
  name: string
  path: string
}

export interface TableData {
  rows: string[][]
  truncated: boolean
}

const MAX_BLOCKS = 600
const MAX_TABLE_ROWS = 200
const MAX_TABLE_COLUMNS = 40
const MAX_SLIDES = 60
const MAX_SHEET_XML = 24 * 1024 * 1024
const MAX_SMALL_XML = 2 * 1024 * 1024

function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length > 0) throw new Error('The document is malformed')
  return doc
}

async function readXml(zip: ZipArchive, name: string, maxSize = MAX_SMALL_XML): Promise<Document | null> {
  const text = await zip.text(name, maxSize)
  return text === null ? null : parseXml(text)
}

function kids(el: Element, localName?: string): Element[] {
  const out: Element[] = []
  for (const c of Array.from(el.children)) if (!localName || c.localName === localName) out.push(c)
  return out
}

function kid(el: Element | undefined, localName: string): Element | undefined {
  if (!el) return undefined
  for (const c of Array.from(el.children)) if (c.localName === localName) return c
  return undefined
}

function all(el: Element | Document, localName: string): Element[] {
  return Array.from(el.getElementsByTagNameNS('*', localName))
}

function attr(el: Element | undefined, localName: string): string | null {
  if (!el) return null
  for (const a of Array.from(el.attributes)) if (a.localName === localName) return a.value
  return null
}

// The namespaced r:id, not a plain id attribute (e.g. <p:sldId id="256" r:id="rId2">).
function relationshipId(el: Element): string {
  for (const a of Array.from(el.attributes)) if (a.localName === 'id' && a.namespaceURI) return a.value
  return ''
}

function relsPathFor(part: string): string {
  const slash = part.lastIndexOf('/')
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`
}

function resolveTarget(part: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = part.split('/')
  parts.pop()
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg && seg !== '.') parts.push(seg)
  }
  return parts.join('/')
}

async function relationships(zip: ZipArchive, part: string): Promise<Map<string, string>> {
  const doc = await readXml(zip, relsPathFor(part))
  const map = new Map<string, string>()
  if (!doc) return map
  for (const rel of all(doc, 'Relationship')) {
    const id = attr(rel, 'Id')
    const target = attr(rel, 'Target')
    if (id && target && attr(rel, 'TargetMode') !== 'External') map.set(id, resolveTarget(part, target))
  }
  return map
}

// --- Word ---------------------------------------------------------------

function isOn(el: Element | undefined): boolean {
  if (!el) return false
  const value = attr(el, 'val')
  return value === null || !['0', 'false', 'off', 'none'].includes(value.toLowerCase())
}

function collectRuns(el: Element, out: DocRun[]): void {
  for (const node of kids(el)) {
    switch (node.localName) {
      case 'r': {
        const props = kid(node, 'rPr')
        let text = ''
        for (const part of kids(node)) {
          if (part.localName === 't') text += part.textContent ?? ''
          else if (part.localName === 'tab') text += '\t'
          else if (part.localName === 'br' || part.localName === 'cr') text += '\n'
          else if (part.localName === 'noBreakHyphen') text += '-'
        }
        if (text) {
          out.push({
            text,
            bold: isOn(kid(props, 'b')),
            italic: isOn(kid(props, 'i')),
            underline: isOn(kid(props, 'u')),
            strike: isOn(kid(props, 'strike'))
          })
        }
        break
      }
      case 'hyperlink':
      case 'ins':
      case 'smartTag':
      case 'fldSimple':
      case 'customXml':
      case 'sdt':
      case 'sdtContent':
        collectRuns(node, out)
        break
    }
  }
}

function paragraphText(p: Element): string {
  const runs: DocRun[] = []
  collectRuns(p, runs)
  return runs.map((r) => r.text).join('')
}

// Built-in styles keep English names (e.g. "heading 1") even in localized documents.
function styleFromName(name: string | undefined): ParagraphStyle {
  if (!name) return 'body'
  if (/^title$/i.test(name)) return 'title'
  const heading = /^heading\s*(\d)$/i.exec(name)
  if (!heading) return 'body'
  const level = Number(heading[1])
  return level <= 1 ? 'heading1' : level === 2 ? 'heading2' : 'heading3'
}

export async function readDocx(zip: ZipArchive): Promise<{ blocks: DocBlock[]; truncated: boolean }> {
  const doc = await readXml(zip, 'word/document.xml', MAX_SHEET_XML)
  if (!doc) throw new Error('This is not a Word document')
  const styleNames = new Map<string, string>()
  const styles = await readXml(zip, 'word/styles.xml').catch(() => null)
  if (styles) {
    for (const style of all(styles, 'style')) {
      const id = attr(style, 'styleId')
      const name = attr(kid(style, 'name'), 'val')
      if (id && name) styleNames.set(id, name)
    }
  }

  const blocks: DocBlock[] = []
  let truncated = false
  const walk = (el: Element) => {
    for (const node of kids(el)) {
      if (blocks.length >= MAX_BLOCKS) {
        truncated = true
        return
      }
      if (node.localName === 'p') {
        const props = kid(node, 'pPr')
        const styleId = attr(kid(props, 'pStyle'), 'val')
        const numbering = kid(props, 'numPr')
        const runs: DocRun[] = []
        collectRuns(node, runs)
        blocks.push({
          type: 'paragraph',
          style: styleFromName(styleId ? (styleNames.get(styleId) ?? styleId) : undefined),
          listLevel: numbering ? Number(attr(kid(numbering, 'ilvl'), 'val') ?? 0) || 0 : null,
          runs
        })
      } else if (node.localName === 'tbl') {
        const rows = kids(node, 'tr')
          .slice(0, MAX_TABLE_ROWS)
          .map((tr) =>
            kids(tr, 'tc')
              .slice(0, MAX_TABLE_COLUMNS)
              .map((tc) => kids(tc, 'p').map(paragraphText).join('\n'))
          )
        blocks.push({ type: 'table', rows })
      } else if (node.localName === 'sdt' || node.localName === 'sdtContent' || node.localName === 'customXml') {
        walk(node)
      }
    }
  }
  const body = all(doc, 'body')[0]
  if (body) walk(body)
  return { blocks, truncated }
}

// --- Excel --------------------------------------------------------------

export async function readSheetList(zip: ZipArchive): Promise<SheetRef[]> {
  const workbook = await readXml(zip, 'xl/workbook.xml')
  if (!workbook) throw new Error('This is not an Excel workbook')
  const rels = await relationships(zip, 'xl/workbook.xml')
  const sheets: SheetRef[] = []
  for (const sheet of all(workbook, 'sheet')) {
    const target = rels.get(relationshipId(sheet))
    if (target && zip.has(target))
      sheets.push({ name: attr(sheet, 'name') ?? `Sheet ${sheets.length + 1}`, path: target })
  }
  return sheets
}

export async function readSharedStrings(zip: ZipArchive): Promise<string[]> {
  const doc = await readXml(zip, 'xl/sharedStrings.xml', MAX_SHEET_XML)
  if (!doc) return []
  return all(doc, 'si').map((si) =>
    all(si, 't')
      .filter((t) => t.parentElement?.localName !== 'rPh')
      .map((t) => t.textContent ?? '')
      .join('')
  )
}

function columnIndex(ref: string | null, fallback: number): number {
  const letters = ref ? /^[A-Z]+/i.exec(ref)?.[0] : undefined
  if (!letters) return fallback
  let n = 0
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

function cellValue(cell: Element, shared: string[]): string {
  const type = attr(cell, 't')
  if (type === 'inlineStr')
    return all(cell, 't')
      .map((t) => t.textContent ?? '')
      .join('')
  const raw = kid(cell, 'v')?.textContent ?? ''
  if (type === 's') return shared[Number(raw)] ?? ''
  if (type === 'b') return raw === '1' ? 'TRUE' : 'FALSE'
  if (type === 'str' || type === 'e' || raw === '') return raw
  const n = Number(raw)
  return Number.isFinite(n) ? String(Number(n.toPrecision(12))) : raw
}

export async function readSheet(zip: ZipArchive, sheet: SheetRef, shared: string[]): Promise<TableData> {
  const doc = await readXml(zip, sheet.path, MAX_SHEET_XML)
  if (!doc) throw new Error('The sheet is missing')
  const rows: string[][] = []
  let truncated = false
  let width = 0
  for (const [i, row] of all(doc, 'row').entries()) {
    const rowNumber = Number(attr(row, 'r')) || i + 1
    if (rowNumber > MAX_TABLE_ROWS) {
      truncated = true
      break
    }
    const cells: string[] = []
    for (const [j, cell] of kids(row, 'c').entries()) {
      const col = columnIndex(attr(cell, 'r'), j)
      if (col >= MAX_TABLE_COLUMNS) {
        truncated = true
        continue
      }
      const value = cellValue(cell, shared)
      if (value) {
        while (cells.length < col) cells.push('')
        cells[col] = value
      }
    }
    if (cells.length === 0) continue
    while (rows.length < rowNumber - 1) rows.push([])
    rows[rowNumber - 1] = cells
    width = Math.max(width, cells.length)
  }
  return { rows: rows.map((r) => [...r, ...Array<string>(width - r.length).fill('')]), truncated }
}

// --- PowerPoint ---------------------------------------------------------

export async function readSlides(zip: ZipArchive): Promise<{ slides: string[][]; total: number }> {
  const presentation = await readXml(zip, 'ppt/presentation.xml')
  if (!presentation) throw new Error('This is not a PowerPoint presentation')
  const rels = await relationships(zip, 'ppt/presentation.xml')
  const targets = all(presentation, 'sldId')
    .map((s) => rels.get(relationshipId(s)))
    .filter((t): t is string => Boolean(t))
  const slides: string[][] = []
  for (const target of targets.slice(0, MAX_SLIDES)) {
    const slide = await readXml(zip, target, MAX_SHEET_XML)
    if (!slide) continue
    slides.push(
      all(slide, 'p')
        .map((p) =>
          all(p, 't')
            .map((t) => t.textContent ?? '')
            .join('')
            .trim()
        )
        .filter(Boolean)
    )
  }
  return { slides, total: targets.length }
}

// --- Document properties ------------------------------------------------

export async function readOfficeProperties(zip: ZipArchive): Promise<Array<[string, string]>> {
  const out: Array<[string, string]> = []
  const push = (label: string, value: string | null | undefined) => {
    const v = value?.trim()
    if (v) out.push([label, v])
  }
  const core = await readXml(zip, 'docProps/core.xml').catch(() => null)
  const app = await readXml(zip, 'docProps/app.xml').catch(() => null)
  const coreField = (name: string) => (core ? all(core, name)[0]?.textContent : null)
  const appField = (name: string) => (app ? all(app, name)[0]?.textContent : null)
  push('Title', coreField('title'))
  push('Authors', coreField('creator'))
  push('Last modified by', coreField('lastModifiedBy'))
  push('Company', appField('Company'))
  push('Content creator', appField('Application'))
  push('Pages', appField('Pages'))
  push('Words', appField('Words'))
  push('Slides', appField('Slides'))
  push('Revision', coreField('revision'))
  return out
}
