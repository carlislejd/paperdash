import { createHash, randomUUID } from "node:crypto";
import { Redis } from "ioredis";

export class CoordinationError extends Error {
  readonly status = 503;
}
export interface CacheLease {
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}
export interface RequestCoordinator {
  acquire(): Promise<() => Promise<void>>;
  defer(milliseconds: number): Promise<void>;
  lock(key: string): Promise<CacheLease | null>;
  close(): void;
}

// TIME keeps the budget independent of clock skew between Render instances.
// Expiring members recover capacity after a crashed process; HTTP deadlines are
// shorter than this lease. noeviction is required on the coordination Redis.
const PERMIT = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local cooldown = tonumber(redis.call('GET', KEYS[1]) or '0')
if cooldown > now then return {-1, cooldown - now} end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[2]) then return {0, 100} end
local nextAt = tonumber(redis.call('GET', KEYS[3]) or '0')
if nextAt > now then return {0, nextAt - now} end
redis.call('SET', KEYS[3], now + tonumber(ARGV[3]), 'PX', 60000)
redis.call('ZADD', KEYS[2], now + 20000, ARGV[1])
redis.call('PEXPIRE', KEYS[2], 25000)
return {1, 0}
`;
const DEFER = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local untilAt = math.max(tonumber(redis.call('GET', KEYS[1]) or '0'), now + tonumber(ARGV[1]))
redis.call('SET', KEYS[1], untilAt, 'PX', math.max(1, untilAt - now))
return 1
`;
const RENEW = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;
const RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export class SharedCooldownError extends CoordinationError {
  constructor(public retryAt: number) {
    super("Papertrade rate limit; serving saved observations when available.");
  }
}

export class RedisCoordinator implements RequestCoordinator {
  private redis: Redis;
  private prefix: string;
  private ready: Promise<unknown>;
  private closed = false;
  constructor(
    url: string,
    namespace: string,
    private options = { concurrency: 3, spacing: 250, wait: 8000 },
  ) {
    this.prefix = `paperdash:upstream:${createHash("sha256").update(namespace).digest("hex").slice(0, 24)}`;
    this.redis = new Redis(url, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      connectTimeout: 3000,
      commandTimeout: 3000,
      retryStrategy: (attempt) => Math.min(1000 * attempt, 15000),
    });
    this.redis.on("error", () => {});
    this.ready = this.redis.connect().catch(() => {});
  }
  private async available() {
    await this.ready;
    if (this.closed || this.redis.status !== "ready")
      throw new CoordinationError(
        "Shared request coordination is unavailable; upstream fetching is paused.",
      );
  }
  async acquire(): Promise<() => Promise<void>> {
    await this.available();
    const token = randomUUID();
    const deadline = Date.now() + this.options.wait;
    do {
      const [admitted, delay] = (await this.redis.eval(
        PERMIT,
        3,
        `${this.prefix}:cooldown`,
        `${this.prefix}:active`,
        `${this.prefix}:next`,
        token,
        this.options.concurrency,
        this.options.spacing,
      )) as [number, number];
      if (admitted === 1)
        return async () => {
          // A failure to release cannot admit excess work: the slot expires.
          await this.redis.zrem(`${this.prefix}:active`, token).catch(() => {});
        };
      if (admitted === -1) throw new SharedCooldownError(Date.now() + delay);
      await sleep(Math.min(250, Math.max(10, delay)));
    } while (!this.closed && Date.now() < deadline);
    throw new CoordinationError(
      "Shared upstream request budget is busy; retry shortly.",
    );
  }
  async defer(milliseconds: number) {
    await this.available();
    await this.redis.eval(
      DEFER,
      1,
      `${this.prefix}:cooldown`,
      Math.max(1, Math.ceil(milliseconds)),
    );
  }
  async lock(key: string): Promise<CacheLease | null> {
    await this.available();
    const name = `${this.prefix}:load:${createHash("sha256").update(key).digest("hex")}`;
    const token = randomUUID();
    const ttl = 45000;
    if ((await this.redis.set(name, token, "PX", ttl, "NX")) !== "OK")
      return null;
    let lost = false;
    const renew = async () => {
      if (lost)
        throw new CoordinationError("Shared cache refresh lease expired.");
      try {
        if ((await this.redis.eval(RENEW, 1, name, token, ttl)) !== 1)
          throw new CoordinationError("Shared cache refresh lease expired.");
      } catch (error) {
        lost = true;
        throw error;
      }
    };
    const timer = setInterval(() => {
      void renew().catch(() => {});
    }, 15000);
    timer.unref();
    return {
      assertOwned: renew,
      release: async () => {
        clearInterval(timer);
        lost = true;
        await this.redis.eval(RELEASE, 1, name, token).catch(() => {});
      },
    };
  }
  close() {
    this.closed = true;
    this.redis.disconnect();
  }
}

/** Local preview only. Production refuses to run without shared coordination. */
export class LocalCoordinator implements RequestCoordinator {
  private locks = new Set<string>();
  private until = 0;
  async acquire() {
    if (Date.now() < this.until) throw new SharedCooldownError(this.until);
    return async () => {};
  }
  async defer(milliseconds: number) {
    this.until = Math.max(this.until, Date.now() + milliseconds);
  }
  async lock(key: string): Promise<CacheLease | null> {
    if (this.locks.has(key)) return null;
    this.locks.add(key);
    return {
      assertOwned: async () => {
        if (!this.locks.has(key))
          throw new CoordinationError("Local cache refresh lease expired.");
      },
      release: async () => {
        this.locks.delete(key);
      },
    };
  }
  close() {}
}
