/**
 * Pluggable storage for the single-user OAuth provider.
 *
 * TEMPLATE NOTE (reusable across MCP servers): this file is generic — it carries
 * no upstream-specific logic. To reuse in another remote MCP, copy it verbatim,
 * call `createOAuthStore("<app>:oauth")` with an app-unique prefix, and pass the
 * result into MinimalOAuthProvider. Set REDIS_URL to persist OAuth tokens across
 * pod rollouts (so claude.ai is not forced to re-authenticate after a deploy);
 * leave it unset for the original in-memory behaviour.
 *
 * Resilience: reads (`get`/`take`) degrade gracefully — on any Redis error they
 * return "miss" so the client re-authenticates, as it would today. Writes (`set`)
 * PROPAGATE errors: a token we cannot persist is worse than a failed request (the
 * client would receive a token that immediately fails verification), so issuance
 * fails loudly and the client retries. A Redis outage never makes the server hang
 * (ioredis rejects fast); it surfaces as a re-auth, never as replay or a phantom
 * token.
 *
 * Single-use: `take` is an atomic get-and-delete (Redis GETDEL) used to redeem
 * authorization codes and rotate refresh tokens, so concurrent requests cannot
 * redeem the same code/token twice.
 */

import Redis from 'ioredis';

export type StoreKind = 'code' | 'access' | 'refresh';

export interface OAuthStore {
  /** ttlSeconds <= 0 means no expiry. */
  set(kind: StoreKind, key: string, value: unknown, ttlSeconds: number): Promise<void>;
  get<T>(kind: StoreKind, key: string): Promise<T | undefined>;
  /** Atomic get-and-delete — single-use redemption. Fail-soft (undefined on error). */
  take<T>(kind: StoreKind, key: string): Promise<T | undefined>;
  del(kind: StoreKind, key: string): Promise<void>;
}

interface MemEntry {
  value: unknown;
  expiresAtMs: number;
}

/** In-memory store. State is lost on restart — sessions reset on every rollout. */
export class MemoryOAuthStore implements OAuthStore {
  private readonly maps: Record<StoreKind, Map<string, MemEntry>> = {
    code: new Map(),
    access: new Map(),
    refresh: new Map(),
  };

  constructor() {
    setInterval(() => this.cleanup(), 60_000).unref();
  }

  async set(kind: StoreKind, key: string, value: unknown, ttlSeconds: number): Promise<void> {
    this.maps[kind].set(key, {
      value,
      expiresAtMs: ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : Number.POSITIVE_INFINITY,
    });
  }

  async get<T>(kind: StoreKind, key: string): Promise<T | undefined> {
    const e = this.maps[kind].get(key);
    if (!e) return undefined;
    if (e.expiresAtMs < Date.now()) {
      this.maps[kind].delete(key);
      return undefined;
    }
    return e.value as T;
  }

  async take<T>(kind: StoreKind, key: string): Promise<T | undefined> {
    const e = this.maps[kind].get(key);
    // Consume unconditionally: the key is single-use, so a hit that turns out
    // to be expired is still removed. JS is single-threaded, so get+delete
    // here is atomic with respect to other awaiting requests.
    this.maps[kind].delete(key);
    if (!e || e.expiresAtMs < Date.now()) return undefined;
    return e.value as T;
  }

  async del(kind: StoreKind, key: string): Promise<void> {
    this.maps[kind].delete(key);
  }

  private cleanup(): void {
    const now = Date.now();
    for (const m of Object.values(this.maps)) {
      for (const [k, e] of m) if (e.expiresAtMs < now) m.delete(k);
    }
  }
}

/** Redis-backed store. Survives pod rollouts. Keys are namespaced by `prefix`. */
export class RedisOAuthStore implements OAuthStore {
  private readonly redis: Redis;

  constructor(
    url: string,
    private readonly prefix: string,
  ) {
    this.redis = new Redis(url, {
      // Fail fast so a Redis outage degrades to cache-miss (→ re-auth) rather
      // than hanging: no offline command queue (commands reject immediately
      // while disconnected instead of waiting for reconnect), no per-command
      // retries, and bounded connect/command timeouts. ioredis still
      // reconnects in the background, so the store self-heals once Redis is back.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      connectTimeout: 3000,
      commandTimeout: 1000,
      lazyConnect: false,
    });
    this.redis.on('error', (e) => console.error(`[oauth-store] redis error: ${e.message}`));
    this.redis.on('connect', () => console.error('[oauth-store] redis connected'));
  }

  private k(kind: StoreKind, key: string): string {
    return `${this.prefix}:${kind}:${key}`;
  }

  async set(kind: StoreKind, key: string, value: unknown, ttlSeconds: number): Promise<void> {
    // Writes propagate errors (unlike reads): failing issuance is better than
    // returning a token that was never persisted and cannot be verified.
    try {
      const s = JSON.stringify(value);
      if (ttlSeconds > 0) await this.redis.set(this.k(kind, key), s, 'EX', Math.ceil(ttlSeconds));
      else await this.redis.set(this.k(kind, key), s);
    } catch (e) {
      console.error(`[oauth-store] set ${kind} failed: ${(e as Error).message}`);
      throw e;
    }
  }

  async get<T>(kind: StoreKind, key: string): Promise<T | undefined> {
    try {
      const s = await this.redis.get(this.k(kind, key));
      return s ? (JSON.parse(s) as T) : undefined;
    } catch (e) {
      console.error(`[oauth-store] get ${kind} failed: ${(e as Error).message}`);
      return undefined;
    }
  }

  async take<T>(kind: StoreKind, key: string): Promise<T | undefined> {
    try {
      // GETDEL (Redis 6.2+) reads and deletes atomically, so two concurrent
      // redemptions of the same code/refresh token cannot both succeed.
      const s = await this.redis.getdel(this.k(kind, key));
      return s ? (JSON.parse(s) as T) : undefined;
    } catch (e) {
      console.error(`[oauth-store] take ${kind} failed: ${(e as Error).message}`);
      return undefined;
    }
  }

  async del(kind: StoreKind, key: string): Promise<void> {
    try {
      await this.redis.del(this.k(kind, key));
    } catch (e) {
      console.error(`[oauth-store] del ${kind} failed: ${(e as Error).message}`);
    }
  }
}

/**
 * Build the store from the environment. REDIS_URL present → Redis (persistent);
 * absent → in-memory. `prefix` MUST be unique per MCP deployment so multiple
 * servers can share one Redis instance without key collisions.
 */
export function createOAuthStore(prefix: string): OAuthStore {
  const url = process.env.REDIS_URL;
  if (url) {
    console.error(`[oauth-store] using Redis store (prefix "${prefix}")`);
    return new RedisOAuthStore(url, prefix);
  }
  console.error('[oauth-store] REDIS_URL not set — using in-memory store (OAuth state resets on restart)');
  return new MemoryOAuthStore();
}
