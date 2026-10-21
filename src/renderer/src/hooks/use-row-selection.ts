import { useCallback, useEffect, useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react'
import type { NodeSummary } from '@shared/types'

const EMPTY_SELECTION: ReadonlySet<string> = new Set()

interface RowSelectionOptions {
  /** Double-click or Enter on a row. */
  onActivate: (item: NodeSummary) => void
  /** Delete (Cmd+Backspace on macOS) or the Delete button, with rows checked. */
  onDelete: (items: NodeSummary[]) => void
  /** Brings a row into view after keyboard navigation. */
  scrollToIndex: (index: number) => void
}

/**
 * Checked rows plus a cursor row for a list view. A click toggles a row, Shift extends a range from the
 * last toggled row, and the cursor follows clicks and arrow keys. Path keys preserve the selection
 * across sorting and refreshes.
 */
export function useRowSelection(rows: NodeSummary[], { onActivate, onDelete, scrollToIndex }: RowSelectionOptions) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(EMPTY_SELECTION)
  const [anchor, setAnchor] = useState<string | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)

  const clearSelection = useCallback(() => {
    setSelected(EMPTY_SELECTION)
    setAnchor(null)
    setCursor(null)
  }, [])

  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev
      const present = new Set(rows.map((r) => r.path))
      const next = new Set<string>()
      for (const p of prev) if (present.has(p)) next.add(p)
      return next.size === prev.size ? prev : next
    })
  }, [rows])

  const indexOf = useMemo(() => new Map(rows.map((r, i) => [r.path, i])), [rows])
  const cursorItem = cursor !== null ? rows[indexOf.get(cursor) ?? -1] : undefined
  const selectedItems = useMemo(() => rows.filter((r) => selected.has(r.path)), [rows, selected])
  const selectedBytes = useMemo(() => selectedItems.reduce((sum, r) => sum + r.size, 0), [selectedItems])
  const allSelected = rows.length > 0 && selectedItems.length === rows.length
  const headerChecked: boolean | 'indeterminate' = allSelected
    ? true
    : selectedItems.length > 0
      ? 'indeterminate'
      : false

  const selectAll = useCallback(() => {
    setSelected(new Set(rows.map((r) => r.path)))
  }, [rows])

  const toggleItem = useCallback((item: NodeSummary) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(item.path)) next.delete(item.path)
      else next.add(item.path)
      return next
    })
    setAnchor(item.path)
    setCursor(item.path)
  }, [])

  const selectRange = useCallback(
    (from: string, to: string, additive: boolean) => {
      const a = indexOf.get(from) ?? indexOf.get(to) ?? 0
      const b = indexOf.get(to) ?? a
      const [lo, hi] = a < b ? [a, b] : [b, a]
      setSelected((prev) => {
        const next = additive ? new Set(prev) : new Set<string>()
        for (let i = lo; i <= hi; i++) next.add(rows[i].path)
        return next
      })
      setCursor(to)
    },
    [indexOf, rows]
  )

  // Row clicks preserve other checked rows.
  const handleRowClick = useCallback(
    (event: MouseEvent, item: NodeSummary) => {
      if (event.shiftKey && anchor) {
        selectRange(anchor, item.path, true)
        return
      }
      toggleItem(item)
    },
    [anchor, selectRange, toggleItem]
  )

  /** Puts the cursor on a row and scrolls to it; false while the row is not listed. */
  const focusRow = useCallback(
    (path: string) => {
      const index = indexOf.get(path)
      if (index === undefined) return false
      setCursor(path)
      setAnchor(path)
      scrollToIndex(index)
      return true
    },
    [indexOf, scrollToIndex]
  )

  const requestDelete = useCallback(() => {
    if (selectedItems.length > 0) onDelete(selectedItems)
  }, [selectedItems, onDelete])

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (rows.length === 0) return
    const key = event.key
    if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === 'a') {
      event.preventDefault()
      selectAll()
      return
    }
    if (key === 'Escape') {
      clearSelection()
      return
    }
    if (key === 'Delete' || (key === 'Backspace' && event.metaKey)) {
      event.preventDefault()
      requestDelete()
      return
    }
    if (key === ' ' && cursor !== null) {
      const item = rows[indexOf.get(cursor) ?? -1]
      if (item) {
        event.preventDefault()
        toggleItem(item)
      }
      return
    }
    if (key === 'Enter') {
      const target =
        cursor !== null ? rows[indexOf.get(cursor) ?? -1] : selectedItems.length === 1 ? selectedItems[0] : undefined
      if (target) {
        event.preventDefault()
        onActivate(target)
      }
      return
    }
    if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End') {
      event.preventDefault()
      const current = cursor !== null ? (indexOf.get(cursor) ?? -1) : -1
      const next =
        key === 'Home'
          ? 0
          : key === 'End'
            ? rows.length - 1
            : Math.max(0, Math.min(rows.length - 1, current + (key === 'ArrowDown' ? 1 : -1)))
      const item = rows[next]
      if (event.shiftKey) {
        selectRange(anchor ?? cursor ?? item.path, item.path, true)
      } else {
        setCursor(item.path)
        setAnchor(item.path)
      }
      scrollToIndex(next)
    }
  }

  return {
    selected,
    cursor,
    cursorItem,
    selectedItems,
    selectedBytes,
    allSelected,
    headerChecked,
    setCursor,
    clearSelection,
    selectAll,
    toggleItem,
    handleRowClick,
    focusRow,
    requestDelete,
    handleKeyDown
  }
}
