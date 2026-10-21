export async function forEachConcurrent<T>(
  items: Iterable<T>,
  concurrency: number,
  visit: (item: T) => Promise<void>
): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError('Concurrency must be a positive integer')
  const iterator = items[Symbol.iterator]()
  let failed = false
  let failure: unknown
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      try {
        while (!failed) {
          const item = iterator.next()
          if (item.done) return
          await visit(item.value)
        }
      } catch (error) {
        if (!failed) failure = error
        failed = true
      }
    })
  )
  if (failed) throw failure
}

export function walkQueue<T>(
  root: T,
  concurrency: number,
  visit: (item: T, enqueue: (item: T) => void) => Promise<void>,
  cancelled: () => boolean
): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError('Concurrency must be a positive integer')
  return new Promise((resolve, reject) => {
    let queue: T[] = [root]
    let head = 0
    let active = 0
    let failure: unknown
    let failed = false
    const pump = () => {
      if (cancelled() || failed) {
        queue = []
        head = 0
      }
      while (active < concurrency && head < queue.length) {
        const item = queue[head++]
        active++
        Promise.resolve()
          .then(() =>
            visit(item, (child) => {
              queue.push(child)
              pump()
            })
          )
          .catch((error: unknown) => {
            failure = error
            failed = true
          })
          .finally(() => {
            active--
            pump()
          })
      }
      if (head >= 4096) {
        queue = queue.slice(head)
        head = 0
      }
      if (!active && head === queue.length) {
        if (failed) reject(failure)
        else resolve()
      }
    }
    pump()
  })
}
