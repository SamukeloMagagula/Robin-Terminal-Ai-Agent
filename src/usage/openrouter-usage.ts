import { AuthStore } from '../auth-store.js';

const KEY_ENDPOINT = 'https://openrouter.ai/api/v1/key';
const CREDITS_ENDPOINT = 'https://openrouter.ai/api/v1/credits';

/**
 * Spend figures as OpenRouter defines them. Field names here mirror the
 * documented meaning rather than the wire names, because the wire names
 * mislead: `usage_daily` is the current *UTC* day, not the local one, and
 * `usage` covers this API key alone, not the account.
 *
 * Reference: GET /api/v1/key and GET /api/v1/credits.
 */
export interface OpenRouterUsage {
  /** Credits used by THIS KEY, all time. */
  keyTotal: number;
  /** Credits used by this key during the current UTC day. */
  keyUtcDay: number;
  /** Current UTC week, starting Monday. */
  keyUtcWeek: number;
  /** Current UTC month. */
  keyUtcMonth: number;
  /** Spending cap configured on this key, or null when uncapped. */
  keyLimit: number | null;
  keyLimitRemaining: number | null;
  /** Bring-your-own-key usage, all time. Zero for most accounts. */
  byokTotal: number;
  /** When this API key expires, or null if it does not. */
  expiresAt: string | null;
  /**
   * OpenRouter's `is_free_tier`, documented as "whether the user has paid for
   * credits before". A purchase-history flag, not a plan name.
   */
  hasEverPurchasedCredits: boolean;
  /** Account-wide figures from /credits. Null when that call did not succeed. */
  account: AccountCredits | null;
}

export interface AccountCredits {
  /** Total credits purchased on the account, all time. */
  purchased: number;
  /** Total credits used on the account, all time, across every key. */
  used: number;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function nullableNum(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nullableStr(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function parseKeyResponse(body: unknown): Omit<OpenRouterUsage, 'account'> {
  const data = ((body as { data?: Record<string, unknown> })?.data ?? {}) as Record<string, unknown>;
  return {
    keyTotal: num(data.usage),
    keyUtcDay: num(data.usage_daily),
    keyUtcWeek: num(data.usage_weekly),
    keyUtcMonth: num(data.usage_monthly),
    keyLimit: nullableNum(data.limit),
    keyLimitRemaining: nullableNum(data.limit_remaining),
    byokTotal: num(data.byok_usage),
    expiresAt: nullableStr(data.expires_at),
    hasEverPurchasedCredits: data.is_free_tier === false,
  };
}

export function parseCreditsResponse(body: unknown): AccountCredits {
  const data = ((body as { data?: Record<string, unknown> })?.data ?? {}) as Record<string, unknown>;
  return { purchased: num(data.total_credits), used: num(data.total_usage) };
}

/** Credits left on the account, or null when the account figures are unavailable. */
export function accountBalance(usage: OpenRouterUsage): number | null {
  if (!usage.account) return null;
  return usage.account.purchased - usage.account.used;
}

async function getJson(url: string, apiKey: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${apiKey}` } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Fetches spend for the stored OpenRouter key.
 *
 * Returns null rather than throwing when the key is missing or the key
 * endpoint fails: usage is decoration on a status line, and a network blip
 * must never take down the prompt it is attached to. The account call is
 * allowed to fail on its own, leaving `account` null, so a per-key reading is
 * still shown.
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

  const [keyBody, creditsBody] = await Promise.all([
    getJson(KEY_ENDPOINT, apiKey),
    getJson(CREDITS_ENDPOINT, apiKey),
  ]);

  if (keyBody === null) return null;
  return {
    ...parseKeyResponse(keyBody),
    account: creditsBody === null ? null : parseCreditsResponse(creditsBody),
  };
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
