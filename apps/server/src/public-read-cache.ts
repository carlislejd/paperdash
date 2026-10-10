/** Small process-local read-through cache. It never initiates upstream work itself. */
export class ReadCapacityError extends Error {
  readonly statusCode = 503;
  constructor() {
    super("The data service is busy. Please retry shortly.");
  }
}
interface Entry {
  value: unknown;
  until: number;
  bytes: number;
}
export class PublicReadCache {
  private entries = new Map<string, Entry>();
  private pending = new Map<string, Promise<unknown>>();
  private bytes = 0;
  constructor(
    private options = {
      ttl: 1000,
      maxEntries: 2048,
      maxBytes: 64 * 1024 * 1024,
      maxPending: 64,
    },
  ) {}
  get size() {
    return this.entries.size;
  }
  get pendingCount() {
    return this.pending.size;
  }
  async read<T>(
    key: string,
    loader: () => Promise<T>,
    ttl = this.options.ttl,
  ): Promise<T> {
    if (ttl <= 0) return loader();
    const saved = this.entries.get(key);
    if (saved && saved.until > Date.now()) {
      this.entries.delete(key);
      this.entries.set(key, saved);
      return saved.value as T;
    }
    const running = this.pending.get(key);
    if (running) return running as Promise<T>;
    if (this.pending.size >= this.options.maxPending)
      throw new ReadCapacityError();
    const promise = Promise.resolve()
      .then(loader)
      .then((value) => {
        // This one serialization measures the cache bound; the same object is reused
        // by the response representation cache for subsequent viewers.
        const bytes = Buffer.byteLength(JSON.stringify(value) ?? "null");
        const previous = this.entries.get(key);
        if (previous) {
          this.bytes -= previous.bytes;
          this.entries.delete(key);
        }
        if (bytes <= this.options.maxBytes) {
          while (
            this.entries.size >= this.options.maxEntries ||
            this.bytes + bytes > this.options.maxBytes
          ) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined) break;
            this.bytes -= this.entries.get(oldest)!.bytes;
            this.entries.delete(oldest);
          }
          this.entries.set(key, { value, bytes, until: Date.now() + ttl });
          this.bytes += bytes;
        }
        return value;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }
  clear() {
    this.entries.clear();
    this.bytes = 0;
  }
}
