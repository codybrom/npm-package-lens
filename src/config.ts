import { workspace, type Uri } from "vscode";

/** The `settings.json` section every setting this extension contributes lives under. */
const CONFIG_SECTION = "npmPackageLens";

/**
 * The status of a version suggestion, used both as the key for the
 * user-configurable indicator glyphs and as the categorization shown in
 * CodeLens titles.
 */
export type SuggestionStatus =
  | "latest"
  | "satisfiesLatest"
  | "match"
  | "noMatch"
  | "major"
  | "minor"
  | "patch"
  | "updatable"
  | "updatableVulnerable"
  | "blocked"
  | "directory"
  | "prerelease"
  | "error";

/** The glyph shown before each suggestion, keyed by {@link SuggestionStatus}. */
export type SuggestionIndicators = Record<SuggestionStatus, string>;

/** Default indicator glyphs, used for any status the user hasn't overridden. */
const DEFAULT_INDICATORS: SuggestionIndicators = {
  latest: "🟢",
  satisfiesLatest: "🟢",
  match: "🟡",
  noMatch: "⚪",
  // Available updates are keyed by severity so the glyph carries the same
  // red/yellow/blue reading as the inline annotation on the same line.
  major: "🔴",
  minor: "🟡",
  patch: "🔵",
  updatable: "↑",
  // An update away from a version with a known advisory — the advisory is
  // against what's declared today, not against what the update moves to.
  updatableVulnerable: "⚠️",
  blocked: "✋",
  directory: "📁",
  prerelease: "🧪",
  error: "🔴",
};

/**
 * `package.json` properties parsed as `"name": "range"` dependency maps.
 * A trailing `.*` matches one level of nesting, so `overrides.*` covers the
 * nested form npm allows (`{ "overrides": { "foo": { "bar": "^1" } } }`).
 */
const DEFAULT_DEPENDENCY_PROPERTIES = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "overrides",
  "overrides.*",
  "resolutions",
  "pnpm.overrides",
  "pnpm.overrides.*",
  "jspm.dependencies",
  "jspm.devDependencies",
  "jspm.peerDependencies",
  "jspm.optionalDependencies",
];

/**
 * Every setting this extension reads, resolved once per use so changes take
 * effect without a reload.
 */
export interface Settings {
  /** Base URL of the registry used for package lookups. */
  registryUrl: string;
  /** How long registry responses are cached, in minutes; `0` disables caching. */
  cacheDurationMinutes: number;
  /** Glob selecting which files are treated as npm manifests. */
  files: string;
  /** Dotted property paths parsed as dependency maps. */
  dependencyProperties: string[];
  /** Whether inline end-of-line annotations are rendered. */
  decorationsEnabled: boolean;
  /** Whether up-to-date dependencies get an inline annotation of their own. */
  showUpToDate: boolean;
  /** Whether opening a manifest triggers an update check automatically. */
  checkOnOpen: boolean;
  /** Whether per-dependency CodeLens suggestions are available at all. */
  codeLensEnabled: boolean;
  /** Whether suggestions start visible rather than needing the toolbar toggle. */
  showSuggestionsOnStartup: boolean;
  /** Whether each dependency section gets a summary CodeLens above it. */
  showSectionSummaries: boolean;
  /** Whether dependencies already on the newest version get suggestions of their own. */
  showUpToDateSuggestions: boolean;
  /** Whether prerelease suggestions start visible. */
  showPrereleasesOnStartup: boolean;
  /** Prerelease tags to show; empty means all of them. */
  prereleaseTagFilter: string[];
  /** Glyphs shown before each suggestion. */
  indicators: SuggestionIndicators;
  /** Whether the status bar summary is shown. */
  statusBarEnabled: boolean;
  /** Whether peer dependency conflicts are analyzed. */
  checkPeerConflicts: boolean;
  /** Whether packages are checked against the OSV vulnerability database. */
  checkVulnerabilities: boolean;
  /** Label of a `tasks.json` task run after dependencies change, if any. */
  onSaveChangesTask: string | undefined;
  /** Whether `npm install` is run in a terminal after an upgrade. */
  runInstallAfterUpgrade: boolean;
}

/**
 * Reads the extension's settings, scoped to `resource`'s workspace folder so
 * a multi-root workspace can configure each folder's registry independently.
 * @param resource - The document the settings are being read for, if any.
 * @returns The resolved settings.
 */
export function getSettings(resource?: Uri): Settings {
  const config = workspace.getConfiguration(CONFIG_SECTION, resource ?? null);

  return {
    registryUrl: stripTrailingSlash(
      config.get<string>("registryUrl", "https://registry.npmjs.org"),
    ),
    cacheDurationMinutes: Math.max(0, config.get<number>("cacheDuration", 10)),
    files: config.get<string>("files", "**/package.json"),
    dependencyProperties: config.get<string[]>(
      "dependencyProperties",
      DEFAULT_DEPENDENCY_PROPERTIES,
    ),
    decorationsEnabled: config.get<boolean>("decorations.enabled", true),
    showUpToDate: config.get<boolean>("decorations.showUpToDate", true),
    checkOnOpen: config.get<boolean>("checkOnOpen", true),
    codeLensEnabled: config.get<boolean>("codeLens.enabled", true),
    showSuggestionsOnStartup: config.get<boolean>(
      "codeLens.showOnStartup",
      true,
    ),
    showSectionSummaries: config.get<boolean>(
      "codeLens.showSectionSummaries",
      true,
    ),
    showUpToDateSuggestions: config.get<boolean>(
      "codeLens.showUpToDate",
      false,
    ),
    showPrereleasesOnStartup: config.get<boolean>(
      "prereleases.showOnStartup",
      false,
    ),
    prereleaseTagFilter: config.get<string[]>("prereleases.tagFilter", []),
    indicators: {
      ...DEFAULT_INDICATORS,
      ...config.get<Partial<SuggestionIndicators>>(
        "suggestions.indicators",
        {},
      ),
    },
    statusBarEnabled: config.get<boolean>("statusBar.enabled", true),
    checkPeerConflicts: config.get<boolean>(
      "peerDependencies.checkConflicts",
      true,
    ),
    checkVulnerabilities: config.get<boolean>("vulnerabilities.enabled", true),
    onSaveChangesTask: nonEmpty(config.get<string>("onSaveChanges")),
    runInstallAfterUpgrade: config.get<boolean>("runInstallAfterUpgrade", true),
  };
}

/**
 * Checks whether a configuration change event touches any of this
 * extension's settings, so listeners can ignore unrelated changes.
 * @param affects - The predicate from a `workspace.onDidChangeConfiguration` event.
 * @returns `true` if a setting in this extension's section changed.
 */
export function affectsSettings(
  affects: (section: string) => boolean,
): boolean {
  return affects(CONFIG_SECTION);
}

/**
 * Normalizes a string setting that is meaningfully "unset" when blank, so
 * callers can test for `undefined` alone rather than also for `""`.
 * @param value - The raw setting value.
 * @returns The trimmed value, or `undefined` if it was missing or blank.
 */
function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

/**
 * Removes a trailing slash so URLs can be built by simple concatenation
 * without producing a double slash.
 * @param url - The URL to normalize.
 * @returns `url` without a trailing slash.
 */
function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
