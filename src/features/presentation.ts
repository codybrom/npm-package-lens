import { formatRelativeTime } from "../format";
import type { BumpSeverity, DependencyStatus } from "../types";

/**
 * How a dependency is rendered, once its update severity, peer conflicts,
 * advisories, and deprecation status have been reduced to a single verdict.
 *
 * Ordering matters: a blocked or vulnerable dependency is shown as such even
 * when the underlying update is only a patch, because the thing the reader
 * needs to act on is the obstruction, not the version gap.
 */
export type DisplayState =
  | "vulnerable"
  | "blocked"
  | "deprecated"
  | "major"
  | "minor"
  | "patch"
  | "upToDate"
  | "unknown";

/** Counts across a manifest, for the status bar and section summaries. */
export interface DependencySummary {
  /** Dependencies with an available update that nothing is blocking. */
  updates: number;
  /** Dependencies whose update a peer requirement blocks. */
  blocked: number;
  /** Dependencies with a known advisory against the version in use. */
  vulnerable: number;
  /** Dependencies already on the newest version. */
  upToDate: number;
  /** Dependencies whose status could be determined at all. */
  comparable: number;
}

/** VS Code theme color IDs, one per display state. */
const THEME_COLORS: Record<DisplayState, string> = {
  vulnerable: "errorForeground",
  blocked: "errorForeground",
  deprecated: "editorWarning.foreground",
  major: "errorForeground",
  minor: "editorWarning.foreground",
  patch: "editorInfo.foreground",
  upToDate: "disabledForeground",
  unknown: "disabledForeground",
};

/**
 * Reduces everything known about a dependency to the single state its
 * annotation is rendered in.
 * @param status - The analyzed dependency.
 * @returns The display state.
 */
export function displayStateOf(status: DependencyStatus): DisplayState {
  if (status.vulnerabilities.length > 0) {
    return "vulnerable";
  }
  if (status.deprecation !== undefined) {
    return "deprecated";
  }
  if (status.bump === "unsupported" || !status.latestVersion) {
    return "unknown";
  }
  if (status.bump === "none") {
    return "upToDate";
  }
  return status.conflicts.length > 0 ? "blocked" : status.bump;
}

/**
 * Resolves the VS Code theme color a display state is rendered in, so
 * annotations use the same red, yellow, and blue the editor already uses for
 * errors, warnings, and information.
 * @param state - The state to look up.
 * @returns A theme color identifier.
 */
export function themeColorId(state: DisplayState): string {
  return THEME_COLORS[state];
}

/**
 * Resolves the CSS variable form of {@link themeColorId}, for use inside
 * HTML-enabled hover markdown.
 * @param state - The state to look up.
 * @returns A `var(--vscode-...)` expression.
 */
export function themeColorVariable(state: DisplayState): string {
  return `var(--vscode-${THEME_COLORS[state].replace(/\./g, "-")})`;
}

/**
 * Builds the end-of-line annotation for one dependency.
 * @param status - The analyzed dependency.
 * @param showUpToDate - Whether up-to-date dependencies get an annotation of their own.
 * @returns The annotation text, or `undefined` if the dependency shouldn't be annotated.
 */
export function annotationFor(
  status: DependencyStatus,
  showUpToDate: boolean,
): string | undefined {
  const state = displayStateOf(status);

  switch (state) {
    case "unknown":
      return undefined;

    case "upToDate":
      return showUpToDate ? "✓ up to date" : undefined;

    case "deprecated":
      return "⊘ deprecated";

    case "vulnerable": {
      const count = status.vulnerabilities.length;
      const advisories = `⚠ ${count.toString()} ${count === 1 ? "advisory" : "advisories"}`;
      const update = updateText(status);
      return update === undefined ? advisories : `${advisories} · ${update}`;
    }

    case "blocked":
      return `✋ ${status.latestVersion ?? ""} blocked by ${describeBlockers(status)}`;

    default:
      return updateText(status);
  }
}

/**
 * Builds the "an update is available" half of an annotation.
 * @param status - The analyzed dependency.
 * @returns Text naming the newer version and how far away it is, or `undefined` if there's no update.
 */
function updateText(status: DependencyStatus): string | undefined {
  if (
    !status.latestVersion ||
    status.bump === "none" ||
    status.bump === "unsupported"
  ) {
    return undefined;
  }

  const publishedAgo = formatRelativeTime(
    status.metadata?.latestVersionPublishedAt,
  );
  const suffix = publishedAgo === undefined ? "" : ` — ${publishedAgo}`;
  return `⬆ ${status.latestVersion} (${status.bump})${suffix}`;
}

/**
 * Names the packages blocking an upgrade, collapsing a long list so the
 * annotation stays readable at the end of a line.
 * @param status - The analyzed dependency.
 * @returns A comma-separated list, with a count standing in past the second name.
 */
export function describeBlockers(status: DependencyStatus): string {
  const names = status.conflicts.map((conflict) => conflict.blockedBy);
  if (names.length <= 2) {
    return names.join(", ");
  }

  return `${names.slice(0, 2).join(", ")} +${(names.length - 2).toString()} more`;
}

/**
 * Counts the dependencies in each state, for summary displays.
 * @param statuses - The analyzed dependencies.
 * @returns The counts.
 */
export function summarize(statuses: DependencyStatus[]): DependencySummary {
  const summary: DependencySummary = {
    updates: 0,
    blocked: 0,
    vulnerable: 0,
    upToDate: 0,
    comparable: 0,
  };

  for (const status of statuses) {
    const state = displayStateOf(status);
    if (state === "unknown") {
      continue;
    }

    summary.comparable++;

    if (status.vulnerabilities.length > 0) {
      summary.vulnerable++;
    }

    if (state === "upToDate" || state === "deprecated") {
      summary.upToDate += state === "upToDate" ? 1 : 0;
      continue;
    }

    if (status.conflicts.length > 0) {
      summary.blocked++;
    } else if (isUpdatable(status.bump)) {
      summary.updates++;
    }
  }

  return summary;
}

/**
 * Checks whether a bump severity represents an actionable update.
 * @param bump - The severity to check.
 * @returns `true` for `major`, `minor`, and `patch`.
 */
export function isUpdatable(bump: BumpSeverity): boolean {
  return bump === "major" || bump === "minor" || bump === "patch";
}

/**
 * Builds the one-line summary shown above a dependency section and in the
 * status bar.
 * @param summary - The counts to describe.
 * @returns A human-readable summary.
 */
export function summaryText(summary: DependencySummary): string {
  if (summary.comparable === 0) {
    return "No comparable dependencies";
  }

  const parts: string[] = [];
  if (summary.updates > 0) {
    parts.push(
      `▲ ${summary.updates.toString()} update${summary.updates === 1 ? "" : "s"} available`,
    );
  }
  if (summary.blocked > 0) {
    parts.push(`✋ ${summary.blocked.toString()} blocked`);
  }
  if (summary.vulnerable > 0) {
    parts.push(`⚠ ${summary.vulnerable.toString()} vulnerable`);
  }

  if (parts.length === 0) {
    return `✓ All ${summary.comparable.toString()} packages up to date`;
  }

  return parts.join(" · ");
}
