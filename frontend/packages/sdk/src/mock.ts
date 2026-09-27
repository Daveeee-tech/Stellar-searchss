/**
 * @stellarcred/sdk — dry-run / mock mode
 *
 * Lets integrators drive every branch of their gate (verified, not-verified,
 * expired, revoked, threshold-not-met, untrusted-issuer, RPC failure) without
 * obtaining real credentials or touching the chain.
 *
 * ## Safety contract
 *
 * Mock mode MUST be enabled explicitly by calling `enableMockMode()`.
 * It can never be activated by an environment variable alone, so an
 * accidental leak of a test flag into a production build cannot enable it.
 * `enableMockMode()` refuses to activate when `NODE_ENV === "production"`
 * and throws `MockProductionError` instead.
 *
 * ## Quick-start
 *
 * ```ts
 * import StellarCred from "@stellarcred/sdk";
 *
 * // Enable once in your test/dev setup file:
 * StellarCred.enableMockMode();
 *
 * // Configure per-claim states for the wallet under test:
 * StellarCred.configureMock("G1WALLET…", "kyc",   { state: "verified" });
 * StellarCred.configureMock("G1WALLET…", "age",   { state: "threshold_not_met" });
 * StellarCred.configureMock("G1WALLET…", "funds", { state: "rpc_failure" });
 *
 * // Now hasClaim / getClaims / useStellarCred return configured values
 * // instead of reaching the chain.
 * const ok = await StellarCred.hasClaim("G1WALLET…", "kyc"); // → true
 * const ok = await StellarCred.hasClaim("G1WALLET…", "age"); // → false
 *
 * // Tear down:
 * StellarCred.clearMock();
 * StellarCred.disableMockMode();
 * ```
 */

import type { ClaimType } from "./index";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when `enableMockMode()` is called in a production environment
 * (`NODE_ENV === "production"`).  Production builds must never silently enter
 * a mock state — if this error surfaces, the caller is mis-configuring the SDK.
 */
export class MockProductionError extends Error {
  constructor() {
    super(
      "[StellarCred] enableMockMode() was called in a production environment " +
        "(NODE_ENV === 'production'). Mock / dry-run mode must never be active in " +
        "production. Remove the enableMockMode() call or guard it with an explicit " +
        "non-production check such as `if (process.env.NODE_ENV !== 'production')`.",
    );
    this.name = "MockProductionError";
  }
}

// ---------------------------------------------------------------------------
// Claim state model
// ---------------------------------------------------------------------------

/**
 * All the distinct states an integrator may want to drive their gate through.
 *
 * | State              | `hasClaim` | `getClaims` entry | Notes                        |
 * | ------------------ | ---------- | ----------------- | ---------------------------- |
 * | `verified`         | `true`     | included          | Default happy path           |
 * | `not_verified`     | `false`    | omitted           | Wallet has no proof          |
 * | `expired`          | `false`    | omitted           | Proof exists but is past expiry |
 * | `revoked`          | `false`    | omitted           | Issuer revoked the proof     |
 * | `threshold_not_met`| `false`    | omitted           | Proof threshold is too low   |
 * | `untrusted_issuer` | `false`    | omitted           | Issuer not in trustedIssuers |
 * | `rpc_failure`      | `false` (or throws when `throwOnError`) | omitted | Simulated network error |
 */
export type MockClaimState =
  | "verified"
  | "not_verified"
  | "expired"
  | "revoked"
  | "threshold_not_met"
  | "untrusted_issuer"
  | "rpc_failure";

/**
 * Per-claim mock configuration.
 */
export interface MockClaimConfig {
  /**
   * Which state to simulate for this wallet + claim combination.
   * Defaults to `"not_verified"` for any wallet/claim that has no explicit
   * entry set (i.e. the mock is in a known, closed state rather than
   * accidentally passing through to the real chain).
   */
  state: MockClaimState;
  /**
   * Unix timestamp (seconds) used as `verifiedAt` when `state === "verified"`.
   * Defaults to `Math.floor(Date.now() / 1000) - 60` (one minute ago).
   */
  verifiedAt?: number;
  /**
   * Unix timestamp (seconds) used as `expiry` when `state === "verified"`.
   * Defaults to `Math.floor(Date.now() / 1000) + 86400 * 30` (30 days from now).
   */
  expiry?: number;
  /**
   * Custom error message surfaced when `state === "rpc_failure"` and the
   * caller has `throwOnError: true`. Defaults to `"Mock RPC failure"`.
   */
  rpcErrorMessage?: string;
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** Whether mock mode is currently active. */
let _mockEnabled = false;

/**
 * Sparse per-wallet, per-claim configuration.
 * Key format: `"<wallet>|<claimType>"`.
 * Missing entries default to `{ state: "not_verified" }`.
 */
const _mockStore = new Map<string, MockClaimConfig>();

function storeKey(wallet: string, claimType: string): string {
  return `${wallet}|${claimType}`;
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

/**
 * Enable dry-run / mock mode.
 *
 * After this call, every `hasClaim`, `getClaims`, `hasClaims`, `getClaim`,
 * `verifyPreset`, and `watchClaim` call returns configured mock values instead
 * of touching the chain. No RPC connection is made, no `registryId` is
 * needed, and no real credentials are required.
 *
 * **Production guard**: throws {@link MockProductionError} when
 * `NODE_ENV === "production"`. This is unconditional and cannot be bypassed —
 * it prevents a stray `enableMockMode()` call from silently neutralising a
 * production gate.
 *
 * @example
 * // In your Jest / Vitest setup file:
 * import StellarCred from "@stellarcred/sdk";
 * StellarCred.enableMockMode();
 */
export function enableMockMode(): void {
  const nodeEnv =
    typeof process !== "undefined"
      ? (process.env as Record<string, string | undefined>).NODE_ENV
      : undefined;

  if (nodeEnv === "production") {
    throw new MockProductionError();
  }

  if (!_mockEnabled) {
    // Only log the activation warning once per enable call.
    // eslint-disable-next-line no-console
    console.warn(
      "[StellarCred] ⚠️  Mock / dry-run mode is ACTIVE. " +
        "hasClaim(), getClaims(), and all claim-check APIs return configured mock " +
        "values — no chain reads are performed. " +
        "This mode must never be enabled in production.",
    );
  }

  _mockEnabled = true;
}

/**
 * Disable dry-run / mock mode and return all claim-check APIs to their normal
 * on-chain behaviour.  Does NOT clear any configured mock entries — call
 * {@link clearMock} separately if you want a clean slate.
 */
export function disableMockMode(): void {
  _mockEnabled = false;
}

/** Returns `true` when mock mode is currently active. */
export function isMockModeActive(): boolean {
  return _mockEnabled;
}

// ---------------------------------------------------------------------------
// Per-claim configuration
// ---------------------------------------------------------------------------

/**
 * Set the mock state for a specific wallet + claim-type combination.
 *
 * Can be called any number of times — later calls overwrite earlier ones for
 * the same wallet/claim pair. Safe to call before `enableMockMode()`.
 *
 * @param wallet   Any string identifier for the wallet under test.  Does NOT
 *                 have to be a valid Stellar G-address so you can use readable
 *                 names like `"alice"` in unit tests.
 * @param claimType  Any recognised {@link ClaimType} string.
 * @param config   The desired mock state and optional timestamp overrides.
 *
 * @example
 * StellarCred.configureMock("G1WALLET…", "kyc",   { state: "verified" });
 * StellarCred.configureMock("G1WALLET…", "age",   { state: "expired" });
 * StellarCred.configureMock("G1WALLET…", "funds", { state: "threshold_not_met" });
 * StellarCred.configureMock("G1WALLET…", "income",{ state: "rpc_failure",
 *                                                    rpcErrorMessage: "upstream timeout" });
 */
export function configureMock(
  wallet: string,
  claimType: ClaimType | string,
  config: MockClaimConfig,
): void {
  _mockStore.set(storeKey(wallet, claimType), { ...config });
}

/**
 * Returns the mock config for a wallet + claim-type, or `undefined` if none
 * has been set.  Useful for assertions in tests.
 */
export function getMockState(
  wallet: string,
  claimType: ClaimType | string,
): MockClaimConfig | undefined {
  return _mockStore.get(storeKey(wallet, claimType));
}

/**
 * Remove all configured mock entries.  Mock mode itself remains in whatever
 * state it was in — call {@link disableMockMode} to also turn it off.
 */
export function clearMock(): void {
  _mockStore.clear();
}

// ---------------------------------------------------------------------------
// Internal resolution helpers used by the public claim APIs
// ---------------------------------------------------------------------------

/**
 * Resolve a mock claim result as if it came from `is_verified`.
 *
 * Returns `null` when:
 *   - mock mode is not active (caller must fall through to the real chain), or
 *   - the configured state is a non-`verified` terminal state.
 *
 * Throws an `Error` when `state === "rpc_failure"` — the caller handles this
 * the same way it would handle a real RPC error (i.e. swallow it when
 * `throwOnError` is false, re-throw when true).
 *
 * @internal
 */
export function _resolveMockIsVerified(
  wallet: string,
  claimType: string,
): { valid: boolean; verifiedAt: number; expiry: number } | null | "not_mock" {
  if (!_mockEnabled) return "not_mock";

  const config = _mockStore.get(storeKey(wallet, claimType)) ?? { state: "not_verified" as const };

  switch (config.state) {
    case "verified": {
      const now = Math.floor(Date.now() / 1000);
      return {
        valid: true,
        verifiedAt: config.verifiedAt ?? now - 60,
        expiry: config.expiry ?? now + 86400 * 30,
      };
    }

    case "rpc_failure":
      // Deliberately throw so the caller's error handling path is exercised.
      throw new Error(config.rpcErrorMessage ?? "Mock RPC failure");

    // All non-verified states → the claim is effectively absent / invalid.
    case "not_verified":
    case "expired":
    case "revoked":
    case "threshold_not_met":
    case "untrusted_issuer":
    default:
      return null;
  }
}

/**
 * Resolve a mock claim result as if it came from `check_claim` (threshold path).
 *
 * Identical semantics to {@link _resolveMockIsVerified} except the threshold
 * is honoured: even a `"verified"` state returns `false` if the configured
 * mock `state` is `"threshold_not_met"`.
 *
 * @internal
 */
export function _resolveMockCheckClaim(
  wallet: string,
  claimType: string,
  minThreshold: number,
): boolean | "not_mock" {
  if (!_mockEnabled) return "not_mock";

  const config = _mockStore.get(storeKey(wallet, claimType)) ?? { state: "not_verified" as const };

  switch (config.state) {
    case "verified":
      // A "verified" mock satisfies any threshold — the integrator can use
      // "threshold_not_met" explicitly when they want to test the failing branch.
      return minThreshold >= 0;

    case "rpc_failure":
      throw new Error(config.rpcErrorMessage ?? "Mock RPC failure");

    case "threshold_not_met":
    case "not_verified":
    case "expired":
    case "revoked":
    case "untrusted_issuer":
    default:
      return false;
  }
}
