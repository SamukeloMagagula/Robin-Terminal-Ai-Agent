/**
 * The environment as it was before Robin touched it.
 *
 * hydrate.ts publishes stored settings into process.env so that the modules
 * reading those variables need no changes. That creates a trap: read the live
 * environment afterwards and a value from settings.json looks exactly like one
 * the user exported, so `robin config` would report the file's own value as
 * "from ROBIN_GATEWAY_PORT, overriding settings.json" — nonsense, and
 * precisely the confusion the source tracking exists to prevent.
 *
 * So precedence is always judged against this snapshot, taken once at startup
 * before hydration. Only a variable the user really set is ever attributed to
 * the environment.
 */

let snapshot: NodeJS.ProcessEnv | null = null;

/** Called once, at startup, before anything hydrates the environment. */
export function capturePristineEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  snapshot = { ...env };
  return snapshot;
}

/**
 * The snapshot, or the live environment if nothing captured one.
 *
 * The fallback matters for anything that constructs a store outside the CLI's
 * startup path — a test, or the gateway loaded as a library. Without
 * hydration there is nothing to be confused by, so the live environment is
 * the right answer there.
 */
export function pristineEnv(): NodeJS.ProcessEnv {
  return snapshot ?? process.env;
}
