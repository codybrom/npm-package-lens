import semver from "semver";
import type { SuggestionStatus } from "../config";
import type { BumpSeverity } from "../types";

/** A single clickable (or purely informational) version suggestion. */
export interface VersionSuggestion {
  /**
   * Whether this describes where the dependency stands today, or offers to
   * move it somewhere new. Only an `"update"` is worth installing after —
   * pinning the manifest to the version already on disk changes nothing an
   * install would reconcile.
   */
  kind: "state" | "update";
  /** How this suggestion relates to the declared specifier. */
  status: SuggestionStatus;
  /** The text shown in the CodeLens, before the status indicator is prepended. */
  label: string;
  /** The concrete version the suggestion refers to, if it names one. */
  version: string | undefined;
  /** The specifier to write into the manifest when clicked, or `undefined` if the suggestion is informational. */
  replacement: string | undefined;
  /**
   * Whether the declared range already admits this version — so applying the
   * suggestion rewrites the manifest without changing what an install
   * produces. True for the common case of a caret range trailing a patch
   * release.
   */
  satisfiedByRange: boolean;
}

/** The inputs a suggestion list is computed from. */
export interface SuggestionContext {
  /** The specifier exactly as declared in the manifest. */
  specifier: string;
  /** Every version published to the registry. */
  versions: string[];
  /** The registry's dist-tags. */
  distTags: Record<string, string>;
  /** Whether prerelease suggestions are included. */
  includePrereleases: boolean;
  /** Prerelease tags to include; empty means all of them. */
  prereleaseTagFilter: string[];
  /**
   * Whether the version currently in use carries a known advisory, which
   * marks the update as security-relevant. It describes the version being
   * moved *away from*, not the one being moved to — an advisory against the
   * newest release is not something the registry document tells us.
   */
  currentIsVulnerable: boolean;
  /** How many packages' peer requirements block updating to the newest version. */
  blockerCount: number;
  /** How far the declared specifier is behind the newest version, for the update's indicator. */
  updateSeverity: BumpSeverity;
  /**
   * Whether to describe a dependency that's already on the newest version.
   * Callers leave this off so suggestions mark out the rows worth acting on,
   * rather than repeating "nothing to do" down the length of a manifest.
   */
  includeUpToDate: boolean;
}

/** Specifier protocols that resolve to something on disk rather than a registry version. */
const LOCAL_PROTOCOL_REGEX = /^(file:|link:|workspace:|portal:)/;

/**
 * Matches the range operator a specifier opens with, so an update can keep
 * the author's chosen looseness (`^1.2.3` updates to `^2.0.0`, not `2.0.0`).
 */
const RANGE_OPERATOR_REGEX = /^(\^|~|>=|<=|>|<|=)?\s*/;

/**
 * Builds the ordered list of version suggestions for one declared
 * dependency.
 *
 * The first suggestion describes the *current* state — whether the specifier
 * resolves to something older than the newest release, or matches nothing
 * published. Any further suggestions are actionable updates, newest first.
 * @param context - The specifier and registry data to reason about.
 * @returns The suggestions, in display order. Empty when there's nothing to say: the specifier isn't comparable to registry versions at all, or it's already on the newest release and `includeUpToDate` is off.
 */
export function getVersionSuggestions(
  context: SuggestionContext,
): VersionSuggestion[] {
  const specifier = context.specifier.trim();

  if (LOCAL_PROTOCOL_REGEX.test(specifier)) {
    return [
      {
        kind: "state",
        status: "directory",
        label: specifier,
        version: undefined,
        replacement: undefined,
        satisfiedByRange: false,
      },
    ];
  }

  const taggedVersion = context.distTags[specifier];
  if (taggedVersion !== undefined) {
    return [
      {
        kind: "state",
        status: specifier === "latest" ? "latest" : "match",
        label: `${specifier} → ${taggedVersion}`,
        version: taggedVersion,
        replacement: undefined,
        satisfiedByRange: true,
      },
    ];
  }

  if (semver.validRange(specifier) === null) {
    return [];
  }

  const latest = resolveLatest(context);
  if (latest === undefined) {
    return [
      {
        kind: "state",
        status: "error",
        label: "no versions",
        version: undefined,
        replacement: undefined,
        satisfiedByRange: false,
      },
    ];
  }

  const state = current(context, latest);
  const update = updateSuggestion(context, latest);
  const prereleases = prereleaseSuggestions(context, latest);

  // Nothing to act on: the specifier already resolves to the newest release
  // and no prerelease is on offer. Saying so on every such row buries the
  // rows that do need attention.
  const isCurrent =
    state.status === "latest" || state.status === "satisfiesLatest";
  if (
    isCurrent &&
    !update &&
    prereleases.length === 0 &&
    !context.includeUpToDate
  ) {
    return [];
  }

  // "Satisfies latest" alongside an available update reads as a
  // contradiction — one badge says nothing to do, the next offers something
  // to do. Where there's an action, the action speaks for itself; the fact
  // that the range already covers it belongs in the tooltip, not a badge.
  const leading = isCurrent && update ? [] : [state];

  return [...leading, ...(update ? [update] : []), ...prereleases];
}

/**
 * Describes what the declared specifier resolves to today: the newest
 * version, some older published version, or nothing at all.
 * @param context - The specifier and registry data.
 * @param latest - The newest stable version published.
 * @returns The leading, informational suggestion.
 */
function current(
  context: SuggestionContext,
  latest: string,
): VersionSuggestion {
  const matched = maxSatisfying(context.versions, context.specifier);

  if (matched === undefined) {
    return {
      kind: "state",
      status: "noMatch",
      label: "no match",
      version: undefined,
      replacement: undefined,
      satisfiedByRange: false,
    };
  }

  if (matched !== latest) {
    // Pinning the manifest to what the range already resolves to is a real
    // action, and the only safe one when a peer requirement blocks the
    // newest release — so this state is clickable when it would change the
    // declared text.
    const pin = applyVersionToSpecifier(context.specifier, matched);
    return {
      kind: "state",
      status: "match",
      label: `Resolved as ${matched}`,
      version: matched,
      replacement: pin === context.specifier.trim() ? undefined : pin,
      satisfiedByRange: true,
    };
  }

  // An exact pin on the newest version is a stronger statement than a range
  // that merely happens to include it, and the two want different labels.
  const isPinned =
    semver.valid(stripOperator(context.specifier)) !== null &&
    RANGE_OPERATOR_REGEX.exec(context.specifier)?.[1] === undefined;

  return {
    kind: "state",
    status: isPinned ? "latest" : "satisfiesLatest",
    label: isPinned ? "latest" : "satisfies latest",
    version: latest,
    replacement: undefined,
    satisfiedByRange: true,
  };
}

/**
 * Builds the "update to the newest version" suggestion, if writing the
 * newest version into the manifest would change what's declared.
 *
 * Offered even when the range already *permits* the newest version —
 * `^9.12.0` admits `9.12.1`, but the number on the line is still behind, and
 * that's what the inline annotation reports. Withholding the action from
 * exactly those rows would leave every caret-compatible update visible but
 * un-actionable, which is the majority of updates. Whether the range already
 * covers the target is recorded on {@link VersionSuggestion.satisfiedByRange}
 * so the UI can say as much where it's useful, without contradicting itself
 * by pairing an available update with a "nothing to do" badge.
 * @param context - The specifier and registry data.
 * @param latest - The newest stable version published.
 * @returns The update suggestion, or `undefined` if there's nothing to update to.
 */
function updateSuggestion(
  context: SuggestionContext,
  latest: string,
): VersionSuggestion | undefined {
  const replacement = applyVersionToSpecifier(context.specifier, latest);
  if (replacement === context.specifier.trim()) {
    return undefined;
  }

  const status = statusForUpdate(context);
  return {
    kind: "update",
    status,
    label: updateLabel(status, latest, context.blockerCount),
    version: latest,
    replacement,
    satisfiedByRange:
      maxSatisfying(context.versions, context.specifier) === latest,
  };
}

/**
 * Phrases an available update, naming what makes it more than routine: a
 * peer requirement standing in the way, or an advisory against the version
 * being left behind.
 * @param status - The indicator status the update renders with.
 * @param latest - The version being offered.
 * @param blockerCount - How many packages object to the update.
 * @returns The label shown in the CodeLens.
 */
function updateLabel(
  status: SuggestionStatus,
  latest: string,
  blockerCount: number,
): string {
  if (status === "blocked") {
    return `${latest} blocked by ${describeBlockerCount(blockerCount)}`;
  }
  if (status === "updatableVulnerable") {
    // Deliberately phrased about the version being left behind: whether the
    // newest release is itself affected isn't something the registry
    // document answers, so promising a fix here would overstate it.
    return `Update to ${latest} — current version has an advisory`;
  }

  return `Update to ${latest}`;
}

/**
 * Phrases how many packages stand in the way of an update, for a label that
 * has to stay short enough to read at a glance.
 * @param count - How many packages object.
 * @returns A phrase like `"2 dependencies"`.
 */
function describeBlockerCount(count: number): string {
  return `${count.toString()} ${count === 1 ? "dependency" : "dependencies"}`;
}

/**
 * Chooses the indicator status for an available update, escalating when a
 * peer requirement stands in the way or the version being left behind
 * carries a known advisory.
 *
 * Blocked wins over security-relevant: an update that can't be applied
 * cleanly is the more immediate fact about it, and the advisory is spelled
 * out in the hover, the diagnostic, and the panel either way.
 * @param context - The specifier and registry data.
 * @returns The status to render the update with.
 */
function statusForUpdate(context: SuggestionContext): SuggestionStatus {
  if (context.blockerCount > 0) {
    return "blocked";
  }
  if (context.currentIsVulnerable) {
    return "updatableVulnerable";
  }

  switch (context.updateSeverity) {
    case "major":
    case "minor":
    case "patch":
      return context.updateSeverity;
    default:
      // An update with no comparable severity — a tag or an odd specifier
      // that still rewrites to something new. Rare, but it needs a glyph.
      return "updatable";
  }
}

/**
 * Builds prerelease suggestions: the newest prerelease ahead of `latest`,
 * plus every dist-tag pointing at a prerelease newer than `latest`.
 *
 * Returns nothing unless prereleases are switched on, since offering an
 * `alpha` build alongside a stable release is noise for most projects.
 * @param context - The specifier and registry data.
 * @param latest - The newest stable version published.
 * @returns The prerelease suggestions, newest first.
 */
function prereleaseSuggestions(
  context: SuggestionContext,
  latest: string,
): VersionSuggestion[] {
  if (!context.includePrereleases) {
    return [];
  }

  const candidates = context.versions
    .filter(
      (version) =>
        semver.valid(version) !== null &&
        semver.prerelease(version) !== null &&
        semver.gt(version, latest) &&
        matchesTagFilter(version, context.prereleaseTagFilter),
    )
    .sort(semver.rcompare);

  const newest = candidates[0];
  if (newest === undefined) {
    return [];
  }

  const tag = Object.entries(context.distTags).find(
    ([, version]) => version === newest,
  )?.[0];

  return [
    {
      kind: "update",
      status: "prerelease",
      label:
        tag === undefined
          ? `Update to ${newest}`
          : `Update to ${newest} (${tag})`,
      version: newest,
      replacement: applyVersionToSpecifier(context.specifier, newest),
      satisfiedByRange: false,
    },
  ];
}

/**
 * Checks a prerelease version against the configured tag filter.
 * @param version - A prerelease version, e.g. `"3.0.0-beta.2"`.
 * @param tagFilter - Tags to allow; an empty filter allows everything.
 * @returns `true` if the version's prerelease tag is allowed.
 */
function matchesTagFilter(version: string, tagFilter: string[]): boolean {
  if (tagFilter.length === 0) {
    return true;
  }

  const identifiers = (semver.prerelease(version) ?? []).map(String);
  return tagFilter.some((tag) => identifiers.includes(tag));
}

/**
 * Determines the newest stable version available, preferring the registry's
 * own `latest` dist-tag over the highest version number — publishers use it
 * to keep a maintenance release current while a newer major stabilizes.
 * @param context - The registry data to read.
 * @returns The newest stable version, or `undefined` if nothing stable is published.
 */
function resolveLatest(context: SuggestionContext): string | undefined {
  const tagged = context.distTags.latest;
  if (tagged !== undefined && semver.valid(tagged) !== null) {
    return tagged;
  }

  return context.versions
    .filter(
      (version) =>
        semver.valid(version) !== null && semver.prerelease(version) === null,
    )
    .sort(semver.rcompare)[0];
}

/**
 * Finds the newest published version the specifier accepts — that is, what
 * npm would actually install for it today.
 *
 * Deliberately *not* `includePrerelease`. Under that flag `^2.0.1` matches
 * `2.2.0-canary`, so a package publishing canary or nightly builds reports
 * one as its resolved version and gets flagged as behind, when npm would
 * install the newest stable release and consider the range satisfied. A
 * specifier that names a prerelease itself (`^2.0.0-beta.1`) still matches
 * prereleases of that same version under default semver rules, which is the
 * behavior npm has.
 * @param versions - Every published version.
 * @param specifier - The declared range.
 * @returns The newest matching version, or `undefined` if none match.
 */
function maxSatisfying(
  versions: string[],
  specifier: string,
): string | undefined {
  return (
    semver.maxSatisfying(
      versions.filter((version) => semver.valid(version) !== null),
      specifier,
    ) ?? undefined
  );
}

/**
 * Rewrites a specifier to point at a new version while keeping the author's
 * range operator, so updating `~1.2.3` yields `~2.0.0` rather than silently
 * pinning or widening what they asked for.
 *
 * Wildcards (`*`, `x`, `latest`) and multi-part ranges (`>=1 <2`) are left
 * alone: they express an intent no single version substitution preserves.
 * @param specifier - The declared specifier.
 * @param version - The version to point at.
 * @returns The rewritten specifier, or the original if it can't be rewritten meaningfully.
 */
export function applyVersionToSpecifier(
  specifier: string,
  version: string,
): string {
  const trimmed = specifier.trim();

  if (trimmed === "" || /[\s|]/.test(trimmed) || /^[*x]$/i.test(trimmed)) {
    return trimmed;
  }

  const operator = RANGE_OPERATOR_REGEX.exec(trimmed)?.[1] ?? "";
  return `${operator}${version}`;
}

/**
 * Strips the leading range operator from a specifier.
 * @param specifier - The declared specifier.
 * @returns The specifier without its operator, e.g. `"1.2.3"` for `"^1.2.3"`.
 */
function stripOperator(specifier: string): string {
  return specifier.trim().replace(RANGE_OPERATOR_REGEX, "");
}
