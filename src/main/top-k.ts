/** Keeps the `limit` items that sort first under `compare`, for items arriving one at a time. */
export class TopK<T> {
  private readonly heap: T[] = []

  constructor(
    private readonly limit: number,
    private readonly compare: (a: T, b: T) => number
  ) {}

  push(item: T): void {
    const { heap, compare } = this
    if (this.limit <= 0) return
    if (heap.length < this.limit) {
      heap.push(item)
      let index = heap.length - 1
      while (index > 0) {
        const parent = (index - 1) >> 1
        if (compare(heap[index], heap[parent]) <= 0) break
        ;[heap[index], heap[parent]] = [heap[parent], heap[index]]
        index = parent
      }
    } else if (compare(item, heap[0]) < 0) {
      heap[0] = item
      let index = 0
      while (index * 2 + 1 < heap.length) {
        let child = index * 2 + 1
        if (child + 1 < heap.length && compare(heap[child + 1], heap[child]) > 0) child++
        if (compare(heap[index], heap[child]) >= 0) break
        ;[heap[index], heap[child]] = [heap[child], heap[index]]
        index = child
      }
    }
  }

  /** The kept items in sorted order. */
  sorted(): T[] {
    return [...this.heap].sort(this.compare)
  }
}

export function topK<T>(items: Iterable<T>, limit: number, compare: (a: T, b: T) => number): T[] {
  const best = new TopK(limit, compare)
  for (const item of items) best.push(item)
  return best.sorted()
}
