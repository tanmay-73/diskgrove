// Reject overlapping operations instead of queuing stale renderer requests.
export class OperationGate {
  private active: string | null = null

  async run<T>(name: string, task: () => Promise<T>): Promise<T> {
    if (this.active) throw new Error(`Wait for ${this.active} to finish before continuing`)
    this.active = name
    try {
      return await task()
    } finally {
      this.active = null
    }
  }
}
