import semver from "semver";
import { PeerConflict } from "../types";

/**
 * One package whose peer requirements are considered when deciding whether
 * an upgrade is safe — that is, one package that could object to it.
 */
export interface PeerSource {
  /** The objecting package's name. */
  name: string;
  /** The version of it currently in play. */
  version: string;
  /** The peer ranges that version requires. */
  peerDependencies: Record<string, string>;
  /**
   * The peer ranges its *own* latest version requires, when known. Used only
   * to answer "would upgrading this package too resolve the conflict?" — a
   * missing value is reported as "no", since an unknown can't be promised.
   */
  latestPeerDependencies: Record<string, string> | undefined;
}

/**
 * Finds the peer requirements that upgrading `packageName` to
 * `targetVersion` would violate.
 *
 * A package objects when it declares a peer range on `packageName` that
 * `targetVersion` falls outside of. Prereleases are matched with
 * `includePrerelease` so a peer range of `^7.0.0` accepts `7.1.0-rc.1`
 * rather than reporting a conflict npm itself wouldn't raise.
 *
 * `packageName` never objects to its own upgrade, even if it declares a
 * self-referential peer range (some packages do, to pin a companion
 * binary).
 * @param packageName - The package being upgraded.
 * @param targetVersion - The exact version being upgraded to.
 * @param sources - Every package whose peer requirements should be considered.
 * @returns One conflict per objecting package, in `sources` order; empty if the upgrade is unobstructed.
 */
export function findPeerConflicts(
  packageName: string,
  targetVersion: string,
  sources: Iterable<PeerSource>,
): PeerConflict[] {
  if (!semver.valid(targetVersion)) {
    return [];
  }

  const conflicts: PeerConflict[] = [];

  for (const source of sources) {
    if (source.name === packageName) {
      continue;
    }

    const requiredRange = source.peerDependencies[packageName];
    if (requiredRange === undefined || accepts(requiredRange, targetVersion)) {
      continue;
    }

    const relaxedRange = source.latestPeerDependencies?.[packageName];
    conflicts.push({
      blockedBy: source.name,
      blockerVersion: source.version,
      requiredRange,
      resolvedByUpgradingBlocker:
        source.latestPeerDependencies !== undefined &&
        (relaxedRange === undefined || accepts(relaxedRange, targetVersion)),
    });
  }

  return conflicts;
}

/**
 * Checks whether a peer range accepts a version.
 *
 * An unparsable range is treated as accepting everything: peer ranges are
 * author-supplied and occasionally use syntax `semver` rejects (a bare git
 * URL, `workspace:*`), and silently blocking every upgrade over a range
 * nothing can evaluate would be worse than not checking it.
 * @param range - The declared peer range.
 * @param version - The exact version being tested.
 * @returns `true` if the range accepts the version, or can't be evaluated.
 */
function accepts(range: string, version: string): boolean {
  if (semver.validRange(range) === null) {
    return true;
  }

  return semver.satisfies(version, range, { includePrerelease: true });
}
