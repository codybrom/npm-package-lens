import * as assert from "assert";
import {
  findPeerConflicts,
  type PeerSource,
} from "../../../src/npm/peer-conflicts";

/**
 * Builds a peer source with sensible defaults, so each test only states the
 * part it cares about.
 * @param overrides - The fields to set.
 * @returns The peer source.
 */
function source(overrides: Partial<PeerSource> & { name: string }): PeerSource {
  return {
    version: "1.0.0",
    peerDependencies: {},
    latestPeerDependencies: undefined,
    ...overrides,
  };
}

suite("peer-conflicts", () => {
  test("Reports nothing when every peer requirement accepts the target", () => {
    const conflicts = findPeerConflicts("vite", "7.3.2", [
      source({ name: "plugin", peerDependencies: { vite: "^7.0.0" } }),
    ]);

    assert.deepEqual(conflicts, []);
  });

  test("Reports a conflict when a peer requirement excludes the target", () => {
    const conflicts = findPeerConflicts("vite", "8.1.0", [
      source({
        name: "plugin",
        version: "2.1.0",
        peerDependencies: { vite: "^7.0.0" },
      }),
    ]);

    assert.deepEqual(conflicts, [
      {
        blockedBy: "plugin",
        blockerVersion: "2.1.0",
        requiredRange: "^7.0.0",
        resolvedByUpgradingBlocker: false,
      },
    ]);
  });

  test("Flags a conflict the blocker's own latest release would resolve", () => {
    const conflicts = findPeerConflicts("vite", "8.1.0", [
      source({
        name: "plugin",
        peerDependencies: { vite: "^7.0.0" },
        latestPeerDependencies: { vite: "^7.0.0 || ^8.0.0" },
      }),
    ]);

    assert.equal(conflicts[0]?.resolvedByUpgradingBlocker, true);
  });

  test("Treats a blocker that dropped the peer entirely as resolving it", () => {
    const conflicts = findPeerConflicts("vite", "8.1.0", [
      source({
        name: "plugin",
        peerDependencies: { vite: "^7.0.0" },
        latestPeerDependencies: {},
      }),
    ]);

    assert.equal(conflicts[0]?.resolvedByUpgradingBlocker, true);
  });

  test("Doesn't promise a resolution when the blocker's latest peers are unknown", () => {
    const conflicts = findPeerConflicts("vite", "8.1.0", [
      source({
        name: "plugin",
        peerDependencies: { vite: "^7.0.0" },
        latestPeerDependencies: undefined,
      }),
    ]);

    assert.equal(conflicts[0]?.resolvedByUpgradingBlocker, false);
  });

  test("Never lets a package block its own upgrade", () => {
    const conflicts = findPeerConflicts("vite", "8.1.0", [
      source({ name: "vite", peerDependencies: { vite: "^7.0.0" } }),
    ]);

    assert.deepEqual(conflicts, []);
  });

  test("Ignores peer requirements on other packages", () => {
    const conflicts = findPeerConflicts("vite", "8.1.0", [
      source({ name: "plugin", peerDependencies: { rollup: "^3.0.0" } }),
    ]);

    assert.deepEqual(conflicts, []);
  });

  test("Accepts a prerelease that falls inside the peer range", () => {
    const conflicts = findPeerConflicts("vite", "7.4.0-beta.1", [
      source({ name: "plugin", peerDependencies: { vite: "^7.0.0" } }),
    ]);

    assert.deepEqual(conflicts, []);
  });

  test("Doesn't block on a peer range it can't evaluate", () => {
    const conflicts = findPeerConflicts("vite", "8.1.0", [
      source({ name: "plugin", peerDependencies: { vite: "workspace:*" } }),
    ]);

    assert.deepEqual(conflicts, []);
  });

  test("Reports nothing when the target version isn't a concrete version", () => {
    const conflicts = findPeerConflicts("vite", "^8", [
      source({ name: "plugin", peerDependencies: { vite: "^7.0.0" } }),
    ]);

    assert.deepEqual(conflicts, []);
  });

  test("Reports every objecting package, in source order", () => {
    const conflicts = findPeerConflicts("vite", "8.1.0", [
      source({ name: "first", peerDependencies: { vite: "^7" } }),
      source({ name: "ok", peerDependencies: { vite: "^8" } }),
      source({ name: "second", peerDependencies: { vite: "6.x" } }),
    ]);

    assert.deepEqual(
      conflicts.map((conflict) => conflict.blockedBy),
      ["first", "second"],
    );
  });
});
