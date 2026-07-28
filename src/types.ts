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
}
