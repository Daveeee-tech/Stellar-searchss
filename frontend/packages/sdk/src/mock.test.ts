/**
 * Tests for the @stellarcred/sdk dry-run / mock mode (Issue #557).
 *
 * These tests exercise every interesting claim state an integrator needs to
 * drive their gate through, plus the production-safety guard.  No mocking of
 * the proof-registry client is needed — when mock mode is active the SDK
 * never constructs a ProofRegistryClient at all.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// We test through the public StellarCred namespace so the integration surface
// is identical to what integrators use.
import StellarCred, {
  enableMockMode,
  disableMockMode,
  isMockModeActive,
  configureMock,
  getMockState,
  clearMock,
  MockProductionError,
  hasClaim,
  getClaim,
  getClaims,
  hasClaims,
  verifyPreset,
} from "./index";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A plausible-looking but fake wallet address used throughout the suite. */
const WALLET = "GBTEST000WALLET000DRYRUN000MOCK000ADDRESS000PLACEHOLDER1";

/** A second wallet to verify per-wallet isolation. */
const WALLET_B = "GBTEST000WALLET000DRYRUN000MOCK000ADDRESS000PLACEHOLDER2";

// ---------------------------------------------------------------------------
// Suite-level setup: ensure mock mode is cleaned up after every test so tests
// cannot bleed state into each other.
// ---------------------------------------------------------------------------

beforeEach(() => {
  clearMock();
  // Tests that need mock mode on will call enableMockMode() themselves.
  // Start each test with it off so we know the default state.
  if (isMockModeActive()) disableMockMode();
});

afterEach(() => {
  clearMock();
  if (isMockModeActive()) disableMockMode();
});

// ---------------------------------------------------------------------------
// 1. Production-safety guard
// ---------------------------------------------------------------------------

describe("production safety guard", () => {
  it("throws MockProductionError when enableMockMode() is called with NODE_ENV=production", () => {
    const original = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      expect(() => enableMockMode()).toThrow(MockProductionError);
      expect(() => enableMockMode()).toThrow(/production environment/);
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  it("does not enable mock mode when the production guard fires", () => {
    const original = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      try { enableMockMode(); } catch { /* expected */ }
      expect(isMockModeActive()).toBe(false);
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  it("MockProductionError is exported on the StellarCred namespace", () => {
    expect(StellarCred.MockProductionError).toBe(MockProductionError);
    expect(new MockProductionError()).toBeInstanceOf(Error);
    expect(new MockProductionError().name).toBe("MockProductionError");
  });

  it("activates successfully in development (NODE_ENV=development)", () => {
    const original = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "development";
      expect(() => enableMockMode()).not.toThrow();
      expect(isMockModeActive()).toBe(true);
    } finally {
      process.env.NODE_ENV = original;
      disableMockMode();
    }
  });

  it("activates successfully in test (NODE_ENV=test)", () => {
    const original = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "test";
      expect(() => enableMockMode()).not.toThrow();
      expect(isMockModeActive()).toBe(true);
    } finally {
      process.env.NODE_ENV = original;
      disableMockMode();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Activation / deactivation
// ---------------------------------------------------------------------------

describe("enableMockMode / disableMockMode / isMockModeActive", () => {
  it("isMockModeActive() returns false before enableMockMode() is called", () => {
    expect(isMockModeActive()).toBe(false);
  });

  it("isMockModeActive() returns true after enableMockMode()", () => {
    enableMockMode();
    expect(isMockModeActive()).toBe(true);
  });

  it("isMockModeActive() returns false after disableMockMode()", () => {
    enableMockMode();
    disableMockMode();
    expect(isMockModeActive()).toBe(false);
  });

  it("can be toggled on and off multiple times", () => {
    enableMockMode();
    disableMockMode();
    enableMockMode();
    expect(isMockModeActive()).toBe(true);
    disableMockMode();
    expect(isMockModeActive()).toBe(false);
  });

  it("is also accessible on the StellarCred namespace", () => {
    StellarCred.enableMockMode();
    expect(StellarCred.isMockModeActive()).toBe(true);
    StellarCred.disableMockMode();
    expect(StellarCred.isMockModeActive()).toBe(false);
  });

  it("emits a console.warn on activation", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    enableMockMode();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Mock / dry-run mode is ACTIVE"));
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 3. configureMock / getMockState / clearMock
// ---------------------------------------------------------------------------

describe("configureMock / getMockState / clearMock", () => {
  it("getMockState returns undefined when no entry has been set", () => {
    expect(getMockState(WALLET, "kyc")).toBeUndefined();
  });

  it("stores and retrieves a mock config", () => {
    configureMock(WALLET, "kyc", { state: "verified" });
    expect(getMockState(WALLET, "kyc")).toEqual({ state: "verified" });
  });

  it("last write wins for the same wallet + claim pair", () => {
    configureMock(WALLET, "kyc", { state: "verified" });
    configureMock(WALLET, "kyc", { state: "revoked" });
    expect(getMockState(WALLET, "kyc")?.state).toBe("revoked");
  });

  it("is keyed per claim type — different types are independent", () => {
    configureMock(WALLET, "kyc",  { state: "verified" });
    configureMock(WALLET, "age",  { state: "expired" });
    expect(getMockState(WALLET, "kyc")?.state).toBe("verified");
    expect(getMockState(WALLET, "age")?.state).toBe("expired");
  });

  it("is keyed per wallet — different wallets are independent", () => {
    configureMock(WALLET,   "kyc", { state: "verified" });
    configureMock(WALLET_B, "kyc", { state: "revoked"  });
    expect(getMockState(WALLET,   "kyc")?.state).toBe("verified");
    expect(getMockState(WALLET_B, "kyc")?.state).toBe("revoked");
  });

  it("clearMock() removes all entries", () => {
    configureMock(WALLET,   "kyc",  { state: "verified" });
    configureMock(WALLET_B, "funds",{ state: "expired"  });
    clearMock();
    expect(getMockState(WALLET,   "kyc")).toBeUndefined();
    expect(getMockState(WALLET_B, "funds")).toBeUndefined();
  });

  it("clearMock() does not affect the enabled/disabled state", () => {
    enableMockMode();
    clearMock();
    expect(isMockModeActive()).toBe(true);
  });

  it("configureMock() is accessible on the StellarCred namespace", () => {
    StellarCred.configureMock(WALLET, "kyc", { state: "verified" });
    expect(StellarCred.getMockState(WALLET, "kyc")).toEqual({ state: "verified" });
    StellarCred.clearMock();
  });
});

// ---------------------------------------------------------------------------
// 4. hasClaim — all seven claim states
// ---------------------------------------------------------------------------

describe("hasClaim — mock states", () => {
  beforeEach(() => enableMockMode());

  it("state=verified → returns true", async () => {
    configureMock(WALLET, "kyc", { state: "verified" });
    await expect(hasClaim(WALLET, "kyc")).resolves.toBe(true);
  });

  it("state=not_verified → returns false", async () => {
    configureMock(WALLET, "kyc", { state: "not_verified" });
    await expect(hasClaim(WALLET, "kyc")).resolves.toBe(false);
  });

  it("state=expired → returns false", async () => {
    configureMock(WALLET, "kyc", { state: "expired" });
    await expect(hasClaim(WALLET, "kyc")).resolves.toBe(false);
  });

  it("state=revoked → returns false", async () => {
    configureMock(WALLET, "kyc", { state: "revoked" });
    await expect(hasClaim(WALLET, "kyc")).resolves.toBe(false);
  });

  it("state=threshold_not_met → returns false (binary path)", async () => {
    configureMock(WALLET, "age", { state: "threshold_not_met" });
    await expect(hasClaim(WALLET, "age")).resolves.toBe(false);
  });

  it("state=threshold_not_met → returns false (threshold path)", async () => {
    configureMock(WALLET, "age", { state: "threshold_not_met" });
    await expect(hasClaim(WALLET, "age", { minThreshold: 21 })).resolves.toBe(false);
  });

  it("state=verified → returns true even when minThreshold is set", async () => {
    configureMock(WALLET, "funds", { state: "verified" });
    await expect(hasClaim(WALLET, "funds", { minThreshold: 50_000 })).resolves.toBe(true);
  });

  it("state=untrusted_issuer → returns false", async () => {
    configureMock(WALLET, "kyc", { state: "untrusted_issuer" });
    await expect(hasClaim(WALLET, "kyc")).resolves.toBe(false);
  });

  it("state=rpc_failure → returns false (fail-soft default)", async () => {
    configureMock(WALLET, "kyc", { state: "rpc_failure" });
    await expect(hasClaim(WALLET, "kyc")).resolves.toBe(false);
  });

  it("state=rpc_failure + throwOnError → throws RpcError", async () => {
    configureMock(WALLET, "kyc", { state: "rpc_failure" });
    const { RpcError } = await import("./index");
    await expect(hasClaim(WALLET, "kyc", { throwOnError: true })).rejects.toBeInstanceOf(RpcError);
  });

  it("state=rpc_failure uses custom rpcErrorMessage", async () => {
    configureMock(WALLET, "kyc", {
      state: "rpc_failure",
      rpcErrorMessage: "upstream timeout from issuer",
    });
    const { RpcError } = await import("./index");
    const err = await hasClaim(WALLET, "kyc", { throwOnError: true }).catch((e) => e);
    expect(err).toBeInstanceOf(RpcError);
    // The custom message surfaces on the underlying cause.
    expect((err as typeof RpcError.prototype).cause).toBeInstanceOf(Error);
    expect(((err as typeof RpcError.prototype).cause as Error).message).toContain(
      "upstream timeout from issuer",
    );
  });

  it("unconfigured wallet+claim defaults to not_verified (false)", async () => {
    // No configureMock call — should default to not_verified, not pass-through to chain.
    await expect(hasClaim(WALLET, "kyc")).resolves.toBe(false);
  });

  it("returns correct result per wallet when two wallets are configured differently", async () => {
    configureMock(WALLET,   "kyc", { state: "verified"    });
    configureMock(WALLET_B, "kyc", { state: "not_verified" });
    await expect(hasClaim(WALLET,   "kyc")).resolves.toBe(true);
    await expect(hasClaim(WALLET_B, "kyc")).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. getClaim — mock states
// ---------------------------------------------------------------------------

describe("getClaim — mock states", () => {
  beforeEach(() => enableMockMode());

  it("state=verified → returns object with valid=true and sensible timestamps", async () => {
    const before = Math.floor(Date.now() / 1000);
    configureMock(WALLET, "kyc", { state: "verified" });
    const result = await getClaim(WALLET, "kyc");
    const after = Math.floor(Date.now() / 1000);

    expect(result).not.toBeNull();
    expect(result!.valid).toBe(true);
    expect(result!.verifiedAt).toBeLessThanOrEqual(before);
    expect(result!.expiry).toBeGreaterThan(after);
  });

  it("state=verified respects custom verifiedAt and expiry", async () => {
    const verifiedAt = 1_700_000_000;
    const expiry     = 1_800_000_000;
    configureMock(WALLET, "kyc", { state: "verified", verifiedAt, expiry });
    const result = await getClaim(WALLET, "kyc");
    expect(result?.verifiedAt).toBe(verifiedAt);
    expect(result?.expiry).toBe(expiry);
  });

  it("state=expired → returns null", async () => {
    configureMock(WALLET, "kyc", { state: "expired" });
    await expect(getClaim(WALLET, "kyc")).resolves.toBeNull();
  });

  it("state=revoked → returns null", async () => {
    configureMock(WALLET, "kyc", { state: "revoked" });
    await expect(getClaim(WALLET, "kyc")).resolves.toBeNull();
  });

  it("state=not_verified → returns null", async () => {
    configureMock(WALLET, "kyc", { state: "not_verified" });
    await expect(getClaim(WALLET, "kyc")).resolves.toBeNull();
  });

  it("state=rpc_failure → returns null (getClaim is always fail-soft)", async () => {
    configureMock(WALLET, "kyc", { state: "rpc_failure" });
    await expect(getClaim(WALLET, "kyc")).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. getClaims — mock states
// ---------------------------------------------------------------------------

describe("getClaims — mock states", () => {
  beforeEach(() => enableMockMode());

  it("returns only the verified claims", async () => {
    configureMock(WALLET, "kyc",   { state: "verified"     });
    configureMock(WALLET, "age",   { state: "expired"      });
    configureMock(WALLET, "funds", { state: "not_verified" });

    const claims = await getClaims(WALLET);
    const types  = claims.map((c) => c.type);
    expect(types).toContain("kyc");
    expect(types).not.toContain("age");
    expect(types).not.toContain("funds");
  });

  it("returns an empty array when no claims are verified", async () => {
    configureMock(WALLET, "kyc",   { state: "revoked"      });
    configureMock(WALLET, "age",   { state: "not_verified" });

    const claims = await getClaims(WALLET);
    expect(claims).toHaveLength(0);
  });

  it("each returned claim has type, verifiedAt, and expiry", async () => {
    const verifiedAt = 1_700_000_000;
    const expiry     = 1_800_000_000;
    configureMock(WALLET, "kyc", { state: "verified", verifiedAt, expiry });

    const claims = await getClaims(WALLET);
    const kycClaim = claims.find((c) => c.type === "kyc");
    expect(kycClaim).toBeDefined();
    expect(kycClaim!.verifiedAt).toBe(verifiedAt);
    expect(kycClaim!.expiry).toBe(expiry);
  });

  it("unconfigured claim types default to not_verified and are omitted", async () => {
    // Only configure kyc; all other types should default to not_verified.
    configureMock(WALLET, "kyc", { state: "verified" });
    const claims = await getClaims(WALLET);
    expect(claims.every((c) => c.type === "kyc")).toBe(true);
    expect(claims).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 7. hasClaims — mock states
// ---------------------------------------------------------------------------

describe("hasClaims — mock states", () => {
  beforeEach(() => enableMockMode());

  it("returns correct boolean per type", async () => {
    configureMock(WALLET, "kyc",   { state: "verified"     });
    configureMock(WALLET, "age",   { state: "expired"      });
    configureMock(WALLET, "funds", { state: "not_verified" });

    const result = await hasClaims(WALLET, ["kyc", "age", "funds"]);
    expect(result.kyc).toBe(true);
    expect(result.age).toBe(false);
    expect(result.funds).toBe(false);
  });

  it("threshold_not_met with minThresholds → false", async () => {
    configureMock(WALLET, "age", { state: "threshold_not_met" });
    const result = await hasClaims(WALLET, ["age"], { minThresholds: { age: 21 } });
    expect(result.age).toBe(false);
  });

  it("verified with minThresholds → true", async () => {
    configureMock(WALLET, "funds", { state: "verified" });
    const result = await hasClaims(WALLET, ["funds"], { minThresholds: { funds: 50_000 } });
    expect(result.funds).toBe(true);
  });

  it("rpc_failure resolves to false per-type, not reject batch", async () => {
    configureMock(WALLET, "kyc",   { state: "rpc_failure" });
    configureMock(WALLET, "funds", { state: "verified"    });
    const result = await hasClaims(WALLET, ["kyc", "funds"]);
    expect(result.kyc).toBe(false);
    expect(result.funds).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. verifyPreset — mock states
// ---------------------------------------------------------------------------

describe("verifyPreset — mock states", () => {
  beforeEach(() => enableMockMode());

  it("allValid is true when all preset claims pass", async () => {
    configureMock(WALLET, "kyc",          { state: "verified" });
    configureMock(WALLET, "accreditation",{ state: "verified" });

    const { allValid, results } = await verifyPreset(WALLET, [
      { type: "kyc" },
      { type: "accreditation", minThreshold: 1_000_000 },
    ]);
    expect(allValid).toBe(true);
    expect(results.kyc).toBe(true);
    expect(results.accreditation).toBe(true);
  });

  it("allValid is false when any preset claim fails", async () => {
    configureMock(WALLET, "kyc",  { state: "verified"    });
    configureMock(WALLET, "funds",{ state: "not_verified" });

    const { allValid } = await verifyPreset(WALLET, [
      { type: "kyc" },
      { type: "funds", minThreshold: 10_000 },
    ]);
    expect(allValid).toBe(false);
  });

  it("untrusted_issuer on one claim fails the whole preset", async () => {
    configureMock(WALLET, "kyc",  { state: "verified"         });
    configureMock(WALLET, "age",  { state: "untrusted_issuer" });

    const { allValid } = await verifyPreset(WALLET, [
      { type: "kyc" },
      { type: "age" },
    ]);
    expect(allValid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 9. watchClaim — mock states
// ---------------------------------------------------------------------------

describe("watchClaim — mock states", () => {
  beforeEach(() => enableMockMode());

  it("resolves immediately when claim is verified", async () => {
    configureMock(WALLET, "kyc", { state: "verified" });
    const result = await StellarCred.watchClaim(WALLET, "kyc", {
      pollMs: 50,
      timeoutMs: 1000,
    });
    expect(result).toBe(true);
  });

  it("fires onChange callback when state transitions to verified", async () => {
    // Start unconfigured (not_verified), then switch to verified after a tick.
    configureMock(WALLET, "kyc", { state: "not_verified" });
    const changes: boolean[] = [];

    const stop = StellarCred.watchClaim(WALLET, "kyc", {
      pollMs: 30,
      timeoutMs: 500,
      onChange: (v) => {
        changes.push(v);
        if (v) stop();
      },
    });

    // Flip to verified after a short delay so the next poll picks it up.
    await new Promise((r) => setTimeout(r, 60));
    configureMock(WALLET, "kyc", { state: "verified" });

    // Give the poller time to see the new state.
    await new Promise((r) => setTimeout(r, 120));
    stop();

    expect(changes).toContain(true);
  });

  it("rejects with TimeoutError when claim never becomes verified", async () => {
    configureMock(WALLET, "kyc", { state: "not_verified" });
    const { TimeoutError } = await import("./index");
    await expect(
      StellarCred.watchClaim(WALLET, "kyc", { pollMs: 20, timeoutMs: 80 }),
    ).rejects.toBeInstanceOf(TimeoutError);
  });
});

// ---------------------------------------------------------------------------
// 10. Mock mode does not affect unrelated wallets / claim types
// ---------------------------------------------------------------------------

describe("isolation", () => {
  beforeEach(() => enableMockMode());

  it("hasClaim for an unconfigured claim type defaults to false, not pass-through", async () => {
    // With mock mode on, there is no chain to fall through to — all unconfigured
    // paths should return the closed/false default, not attempt an RPC read.
    await expect(hasClaim(WALLET, "income")).resolves.toBe(false);
  });

  it("disabling mock mode and re-enabling gives a clean slate for activation state", () => {
    disableMockMode();
    expect(isMockModeActive()).toBe(false);
    enableMockMode();
    expect(isMockModeActive()).toBe(true);
  });
});
