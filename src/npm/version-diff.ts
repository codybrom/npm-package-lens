import semverUtils from "semver-utils";
import { BumpSeverity } from "../types";

/** Matches an npm alias version declaration, e.g. `npm:@foo/bar@^1.2.3`. */
const NPM_ALIAS_REGEX = /^npm:(.+)@([^@]*)$/;

/**
 * Matches the non-registry specifier forms documented at
 * {@link https://docs.npmjs.com/cli/v12/using-npm/package-spec}: git URLs
 * (`git+https://...`, `git://...`), GitHub shorthand (`github:user/repo`,
 * `user/repo#ref`), local paths/tarballs (`./foo`, `../foo`, `/foo`,
 * `~/foo`), remote tarballs (`https://...tgz`), and the `file:`, `link:`,
 * and `workspace:` protocols. None of these resolve to a single fixed
 * version comparable against the npm registry.
 */
const UNSUPPORTED_SPECIFIER_REGEX =
  /^(git\+|git:\/\/|github:|gitlab:|bitbucket:|file:|link:|workspace:|https?:\/\/|\.\.?\/|~\/|\/)|\.(tgz|tar\.gz)($|#)|^[^@/\s]+\/[^@\s]+(#|$)/;

/**
 * A parsed npm dependency version specifier, discriminated by how (or
 * whether) it can be compared against the registry's latest version.
 */
export type ParsedSpecifier =
  | { kind: "range"; range: string }
  | { kind: "tag"; tag: string }
  | { kind: "alias"; packageName: string; inner: ParsedSpecifier }
  | { kind: "unsupported" };

/**
 * Classifies a raw `package.json` version specifier per
 * {@link https://docs.npmjs.com/cli/v12/using-npm/package-spec}.
 *
 * This is the first step in resolving any specifier: callers should
 * classify before deciding how (or whether) to fetch a comparison version —
 * a `"range"` compares directly, a `"tag"` needs a dist-tag lookup, an
 * `"alias"` needs its `inner` specifier classified against the aliased
 * package, and `"unsupported"` (git/GitHub/local/tarball/`workspace:`/etc.)
 * has no single registry version to compare against at all.
 * @param specifier - The raw specifier, e.g. `"^1.2.3"`, `"latest"`, `"npm:foo@1.2.3"`, `"workspace:*"`.
 * @returns The classified specifier.
 * @example
 * ```ts
 * classifySpecifier("^1.2.3");              // { kind: "range", range: "^1.2.3" }
 * classifySpecifier("latest");               // { kind: "tag", tag: "latest" }
 * classifySpecifier("npm:foo@^1.2.3");       // { kind: "alias", packageName: "foo", inner: { kind: "range", ... } }
 * classifySpecifier("workspace:*");          // { kind: "unsupported" }
 * classifySpecifier("github:user/repo#main"); // { kind: "unsupported" }
 * ```
 */
export function classifySpecifier(specifier: string): ParsedSpecifier {
  const trimmed = specifier.trim();

  const aliasMatch = NPM_ALIAS_REGEX.exec(trimmed);
  if (aliasMatch) {
    const [, packageName, inner] = aliasMatch;
    if (packageName && inner !== undefined) {
      return {
        kind: "alias",
        packageName,
        inner: classifySpecifier(inner),
      };
    }
  }

  if (UNSUPPORTED_SPECIFIER_REGEX.test(trimmed)) {
    return { kind: "unsupported" };
  }

  if (isParsableSemverRange(trimmed)) {
    return { kind: "range", range: trimmed };
  }

  if (/^[a-z0-9][a-z0-9._-]*$/i.test(trimmed)) {
    return { kind: "tag", tag: trimmed };
  }

  return { kind: "unsupported" };
}

/**
 * Resolves a classified specifier down to a single concrete version string
 * comparable against the registry's latest version, using `distTags` to
 * look up tags.
 *
 * Caveat: for an `alias` whose `inner` specifier is itself a `tag` (e.g.
 * `"npm:other-pkg@beta"`), the tag is resolved against `distTags` as
 * passed in — which callers will have fetched for the *aliased* package
 * (`other-pkg`), not the name declared in `package.json`. Callers that
 * fetch `distTags` before classifying should fetch it for
 * {@link ParsedSpecifier}'s `packageName` when `kind` is `"alias"`.
 * @param specifier - The classified specifier to resolve.
 * @param distTags - The dist-tags of the package this specifier ultimately resolves to (the alias target's, if `kind` is `"alias"`).
 * @returns A concrete version string, or `undefined` if `specifier` is a tag with no matching entry in `distTags`, or is `"unsupported"`.
 * @example
 * ```ts
 * resolveInstalledVersion(classifySpecifier("^1.2.3"), {});                 // "^1.2.3"
 * resolveInstalledVersion(classifySpecifier("beta"), { beta: "2.0.0-beta.1" }); // "2.0.0-beta.1"
 * resolveInstalledVersion(classifySpecifier("workspace:*"), {});            // undefined
 * ```
 */
export function resolveInstalledVersion(
  specifier: ParsedSpecifier,
  distTags: Record<string, string>,
): string | undefined {
  switch (specifier.kind) {
    case "range":
      return specifier.range;
    case "tag":
      return distTags[specifier.tag];
    case "alias":
      return resolveInstalledVersion(specifier.inner, distTags);
    case "unsupported":
      return undefined;
  }
}

/**
 * Determines which semver part changed between an installed version range
 * and the latest published version.
 *
 * Mirrors {@link https://github.com/raineorshine/npm-check-updates | npm-check-updates}'
 * `partChanged`: the range operator is stripped from each side
 * independently (an upgrade commonly changes the operator, e.g.
 * `<1.2.3` → `^1.2.9`), then the remaining `major.minor.patch` parts are
 * diffed positionally.
 *
 * Versions on major version `0` are always reported as `"major"` on any
 * change, since semver makes no compatibility guarantee below `1.0.0`.
 *
 * Callers are expected to pass `installedVersion` already resolved via
 * {@link classifySpecifier} and {@link resolveInstalledVersion} — a `range`
 * or resolved `tag` passes straight through, while `undefined` is the
 * signal that resolution failed (an `unsupported` specifier, or a `tag`
 * with no matching dist-tag) and is reported as `"unsupported"` rather than
 * silently treated as "up to date".
 * @param installedVersion - The resolved installed version, or `undefined` if it couldn't be resolved to a comparable version.
 * @param latestVersion - The latest version published to the registry, e.g. `"2.0.0"`.
 * @returns The severity of the change; `"unsupported"` if `installedVersion` is missing, `"none"` if `latestVersion` is missing or the versions match, otherwise `"major"`/`"minor"`/`"patch"`.
 * @example
 * ```ts
 * getBumpSeverity("^6.19.0", "7.9.1"); // "major"
 * getBumpSeverity("^1.2.3", "1.2.3");  // "none" (already latest)
 * getBumpSeverity(undefined, "1.2.3"); // "unsupported"
 * ```
 */
export function getBumpSeverity(
  installedVersion: string | undefined,
  latestVersion: string | undefined,
): BumpSeverity {
  if (!installedVersion) {
    return "unsupported";
  }
  if (!latestVersion) {
    return "none";
  }

  const from = normalizeToVersionTriple(installedVersion);
  const to = normalizeToVersionTriple(latestVersion);

  if (!from || !to || from === to) {
    return "none";
  }

  const fromParts = from.split(".");
  const toParts = to.split(".");

  const diffIndex = toParts.findIndex((part, i) => part !== fromParts[i]);
  if (diffIndex === -1) {
    return "none";
  }

  if (toParts[0] === "0") {
    return "major";
  }

  if (diffIndex === 0) {
    return "major";
  }
  if (diffIndex === 1) {
    return "minor";
  }
  return "patch";
}

/**
 * Checks whether `semverUtils` can extract at least a major version from
 * `candidate`.
 * @param candidate - A range or bare version string.
 * @returns `true` if `candidate` parses to something with a major version.
 */
function isParsableSemverRange(candidate: string): boolean {
  const [parsed] = semverUtils.parseRange(candidate);
  return Boolean(parsed?.major);
}

/**
 * Reduces a version range down to a bare `major.minor.patch` string
 * suitable for positional diffing. Unlike {@link classifySpecifier}, this
 * does not resolve tags, aliases, or unsupported specifiers — it only
 * strips range operators from an already-concrete-ish range.
 * @param version - A range or bare version string, e.g. `"^1.2.3"`.
 * @returns A `"major.minor.patch"` string, or `undefined` if `version` isn't a parsable semver.
 */
function normalizeToVersionTriple(version: string): string | undefined {
  const [parsed] = semverUtils.parseRange(version.trim());
  if (!parsed?.major) {
    return undefined;
  }

  return [parsed.major, parsed.minor ?? "0", parsed.patch ?? "0"].join(".");
}
