import type { DependencyEntry } from "./parse/package-document";

/**
 * Severity of an available update, expressed in semver terms.
 *
 * `"unsupported"` means the installed specifier (git URL, `workspace:*`,
 * local path, unresolvable alias, etc.) has no single registry version to
 * compare against — distinct from `"none"`, which means a comparison *was*
 * made and the versions match.
 */
export type BumpSeverity = "major" | "minor" | "patch" | "none" | "unsupported";

/**
 * Metadata resolved from the npm registry for a single package, independent
 * of any specific document or editor position.
 */
export interface RegistryMetadata {
  /** The package's canonical name, as published (may differ in casing from the request). */
  name: string | undefined;
  /** The `dist-tags.latest` version, or `undefined` if the registry lookup failed. */
  latestVersion: string | undefined;
  /** The package's one-line description, or `undefined` if none is published. */
  description: string | undefined;
  /** The package's homepage URL, if one is published. */
  homepage: string | undefined;
  /** The package's source repository URL (normalized to a plain `https://` link), if published. */
  repositoryUrl: string | undefined;
  /** ISO 8601 timestamp of when {@link latestVersion} was published, if known. */
  latestVersionPublishedAt: string | undefined;
  /** All published dist-tags (e.g. `{ latest: "4.18.1", next: "5.0.0-beta.1" }`). */
  distTags: Record<string, string>;
  /** Every published version, in the order the registry lists them. */
  versions: string[];
  /** ISO 8601 publish timestamp per version, plus the registry's own `created`/`modified` keys. */
  publishedAt: Record<string, string>;
  /** Required (non-optional) peer dependency ranges, per published version. */
  peerDependenciesByVersion: Record<string, Record<string, string>>;
  /** Deprecation message per version, for versions the publisher has deprecated. */
  deprecations: Record<string, string>;
}

/**
 * A peer dependency requirement that an upgrade would violate, and which
 * therefore blocks that upgrade.
 */
export interface PeerConflict {
  /** The package declaring the peer requirement the upgrade would violate. */
  blockedBy: string;
  /** The version of {@link blockedBy} currently in the project. */
  blockerVersion: string;
  /** The range {@link blockedBy} requires of the package being upgraded. */
  requiredRange: string;
  /**
   * Whether upgrading {@link blockedBy} to its own latest version would
   * widen {@link requiredRange} enough to unblock the upgrade — the
   * difference between "wait for upstream" and "upgrade both together".
   */
  resolvedByUpgradingBlocker: boolean;
}

/** A security advisory affecting a specific version of a package. */
export interface Vulnerability {
  /** The advisory's OSV identifier, e.g. `"GHSA-1234-5678-90ab"`. */
  id: string;
  /** A one-line description of the issue, if the advisory publishes one. */
  summary: string | undefined;
  /** The advisory's severity band (`"LOW"`, `"MODERATE"`, `"HIGH"`, `"CRITICAL"`), if rated. */
  severity: string | undefined;
  /** Link to the advisory. */
  url: string;
  /** The lowest version that fixes the issue, if the advisory names one. */
  fixedVersion: string | undefined;
}

/**
 * The fully-analyzed state of one declared dependency: what the manifest
 * says, what the registry has, and what stands in the way of upgrading.
 */
export interface DependencyStatus {
  /** The entry as parsed from the manifest. */
  entry: DependencyEntry;
  /** The package's registry metadata, or `undefined` if the lookup failed. */
  metadata: RegistryMetadata | undefined;
  /**
   * The declared specifier resolved to a concrete comparable version:
   * ranges pass through, dist-tags resolve via the registry, and
   * non-registry specifiers resolve to `undefined`.
   */
  resolvedSpecifier: string | undefined;
  /** The version actually present in `node_modules`, when it could be read. */
  installedVersion: string | undefined;
  /** The registry's `dist-tags.latest`, if known. */
  latestVersion: string | undefined;
  /** How far behind {@link latestVersion} the declared specifier is. */
  bump: BumpSeverity;
  /** Peer requirements that upgrading to {@link latestVersion} would violate. */
  conflicts: PeerConflict[];
  /** Advisories affecting the version currently in use. */
  vulnerabilities: Vulnerability[];
  /** The publisher's deprecation notice for the version in use, if deprecated. */
  deprecation: string | undefined;
}

/**
 * {@link RegistryMetadata} joined with the version range declared in the
 * user's `package.json`, ready for display.
 */
export interface PackageMetadata {
  /** The package's canonical name. */
  name: string;
  /** The version specifier exactly as written in `package.json` (e.g. `^1.2.3`, `beta`), if known. */
  installedVersion?: string | undefined;
  /**
   * `installedVersion` resolved to a concrete, comparable version: ranges
   * pass through unchanged, dist-tags (e.g. `"beta"`) resolve via the
   * registry's dist-tags, and non-registry specifiers (git URLs,
   * `workspace:*`, aliases to other packages, etc.) resolve to `undefined`.
   * This is what {@link BumpSeverity} is computed from — `installedVersion`
   * is for display only.
   */
  resolvedInstalledVersion?: string | undefined;
  /** The latest version published to the registry. */
  latestVersion: string;
  /** The package's one-line description. */
  description?: string | undefined;
  /** Formatted monthly download count (e.g. `"1.2M"`), if available. */
  downloads?: string | undefined;
  /** The package's homepage URL, if published. */
  homepage?: string | undefined;
  /** The package's source repository URL, if published. */
  repositoryUrl?: string | undefined;
  /** ISO 8601 timestamp of when {@link latestVersion} was published, if known. */
  latestVersionPublishedAt?: string | undefined;
  /** Peer requirements blocking an upgrade to {@link latestVersion}. */
  conflicts?: PeerConflict[] | undefined;
  /** Advisories affecting the version currently in use. */
  vulnerabilities?: Vulnerability[] | undefined;
  /** The publisher's deprecation notice for the version in use, if deprecated. */
  deprecation?: string | undefined;
}
