import { AuthStore } from '../auth-store.js';

const KEY_ENDPOINT = 'https://openrouter.ai/api/v1/key';

export interface OpenRouterUsage {
  /** Spend in USD. */
  total: number;
  daily: number;
  weekly: number;
  monthly: number;
  /** Credit limit on the key, or null when the key has no limit set. */
  limit: number | null;
  limitRemaining: number | null;
  isFreeTier: boolean;
}

interface KeyResponse {
  data?: {
    usage?: number;
    usage_daily?: number;
    usage_weekly?: number;
    usage_monthly?: number;
    limit?: number | null;
    limit_remaining?: number | null;
    is_free_tier?: boolean;
  };
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function nullableNum(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function parseUsage(body: unknown): OpenRouterUsage {
  const data = (body as KeyResponse)?.data ?? {};
  return {
    total: num(data.usage),
    daily: num(data.usage_daily),
    weekly: num(data.usage_weekly),
    monthly: num(data.usage_monthly),
    limit: nullableNum(data.limit),
    limitRemaining: nullableNum(data.limit_remaining),
    isFreeTier: data.is_free_tier === true,
  };
}

/**
 * Fetches spend for the stored OpenRouter key.
 *
 * Returns null rather than throwing when the key is missing or the request
 * fails: usage is decoration on a status line, and a network blip must never
 * take down the prompt that line is attached to.
 */
export async function fetchOpenRouterUsage(
  authStore: AuthStore = new AuthStore()
): Promise<OpenRouterUsage | null> {
  let apiKey: string | undefined;
  try {
    apiKey = (await authStore.get('openrouter'))?.apiKey as string | undefined;
  } catch {
    return null;
  }
  if (!apiKey) return null;

  try {
    const res = await fetch(KEY_ENDPOINT, { headers: { authorization: `Bearer ${apiKey}` } });
    if (!res.ok) return null;
    return parseUsage(await res.json());
  } catch {
    return null;
  }
}

/**
 * Caches the last successful reading so a per-turn status line does not spend
 * an API round-trip — and a rate-limit slot — on every single message.
 */
export class UsageCache {
  private cached: OpenRouterUsage | null = null;
  private fetchedAt = 0;
  private inFlight: Promise<OpenRouterUsage | null> | undefined;

  constructor(
    private readonly ttlMs = 60_000,
    private readonly fetcher: () => Promise<OpenRouterUsage | null> = fetchOpenRouterUsage,
    private readonly now: () => number = Date.now
  ) {}

  /** The cached reading, or null if nothing has been fetched yet. Never blocks. */
  peek(): OpenRouterUsage | null {
    return this.cached;
  }

  async get(): Promise<OpenRouterUsage | null> {
    if (this.cached && this.now() - this.fetchedAt < this.ttlMs) return this.cached;
    // Collapse concurrent callers onto one request.
    if (!this.inFlight) {
      this.inFlight = this.fetcher()
        .then((usage) => {
          if (usage) {
            this.cached = usage;
            this.fetchedAt = this.now();
          }
          return usage;
        })
        .finally(() => {
          this.inFlight = undefined;
        });
    }
    return this.inFlight;
  }

  /** Drops the cached value so the next get() re-fetches. */
  invalidate(): void {
    this.cached = null;
    this.fetchedAt = 0;
  }
}
