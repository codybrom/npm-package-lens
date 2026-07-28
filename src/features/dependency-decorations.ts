import {
  DecorationOptions,
  ExtensionContext,
  Range,
  TextDocument,
  TextEditor,
  TextEditorDecorationType,
  ThemeColor,
  window,
  workspace,
} from "vscode";
import { formatRelativeTime } from "../format";
import { getLatestNodeLts } from "../npm/nodejs-releases";
import { getRegistryMetadata } from "../npm/registry-client";
import {
  classifySpecifier,
  getBumpSeverity,
  resolveInstalledVersion,
} from "../npm/version-diff";
import { BumpSeverity } from "../types";

/** Where a version specifier's "latest" comparison value comes from. */
type LookupSource = "npm" | "node";

/** A single `"name": "range"` entry found somewhere annotatable in the document. */
interface DependencyMatch {
  /** The npm package name (or `"node"` for {@link LookupSource.node} entries), as written in `package.json`. */
  packageName: string;
  /** The version range as written in `package.json`, e.g. `"^1.2.3"`. */
  installedVersion: string;
  /** The zero-width range at the end of the line, where the annotation is rendered. */
  range: Range;
  /** Which registry to resolve `packageName`'s latest version against. */
  source: LookupSource;
}

/**
 * Top-level `package.json` keys that contain nested `"name": "range"`
 * dependency entries, resolvable against the npm registry.
 */
const DEPENDENCY_SECTION_KEYS = new Set([
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "overrides",
  "resolutions",
]);

/** Maximum number of concurrent in-flight registry lookups per decoration pass. */
const MAX_CONCURRENT_LOOKUPS = 8;

/** How long a resolved "latest version" is cached before being re-fetched. */
const CACHE_TTL_MS = 10 * 60 * 1000;

/** A cached registry lookup result for one package. */
interface CachedRegistryEntry {
  /** The latest published version, or `undefined` if the lookup failed. */
  latestVersion: string | undefined;
  /** ISO 8601 publish timestamp of {@link latestVersion}, if known. */
  latestVersionPublishedAt: string | undefined;
  /** Published dist-tags, for resolving tag specifiers (e.g. `"beta"`). Empty for `"node"` source entries. */
  distTags: Record<string, string>;
  /** When this entry should be considered stale and re-fetched. */
  expiresAt: number;
}

/**
 * In-memory cache of `"source:packageName" -> latest version info`, shared
 * across all open documents. Keyed by source too so a Node.js lookup and an
 * npm package coincidentally named the same thing can't collide.
 */
const registryCache = new Map<string, CachedRegistryEntry>();

/**
 * One decoration type per severity, so each can carry its own theme color.
 * `unsupported` is never actually applied (those lines are skipped
 * entirely, see {@link updateDecorations}) but is still required to
 * satisfy `Record<BumpSeverity, ...>`.
 */
const decorationTypes: Record<BumpSeverity, TextEditorDecorationType> = {
  major: createDecorationType("errorForeground"),
  minor: createDecorationType("editorWarning.foreground"),
  patch: createDecorationType("editorInfo.foreground"),
  none: createDecorationType("disabledForeground"),
  unsupported: createDecorationType("disabledForeground"),
};

/**
 * Registers the inline dependency-status decorations feature: an
 * end-of-line annotation on each dependency in an open `package.json`,
 * refreshed whenever that file becomes active or is saved.
 * @param context - The extension context to register disposables against.
 */
export function registerDependencyDecorations(context: ExtensionContext): void {
  const decorate = (editor: TextEditor | undefined): void => {
    if (editor && isPackageJson(editor.document)) {
      void updateDecorations(editor);
    }
  };

  decorate(window.activeTextEditor);

  context.subscriptions.push(
    window.onDidChangeActiveTextEditor(decorate),
    workspace.onDidSaveTextDocument((document) => {
      const editor = window.visibleTextEditors.find(
        (candidate) => candidate.document === document,
      );
      if (editor && isPackageJson(document)) {
        void updateDecorations(editor);
      }
    }),
    ...Object.values(decorationTypes),
  );
}

/**
 * Creates a decoration type that renders an `after`-text annotation in the
 * given theme color.
 * @param colorId - A VS Code theme color identifier (e.g. `"errorForeground"`).
 * @returns A disposable decoration type; callers are responsible for disposal.
 */
function createDecorationType(colorId: string): TextEditorDecorationType {
  return window.createTextEditorDecorationType({
    after: {
      margin: "0 0 0 1rem",
      color: new ThemeColor(colorId),
    },
  });
}

/**
 * Checks whether `document` is a `package.json` file this feature should
 * annotate.
 * @param document - The document to check.
 * @returns `true` if the document is a JSON/JSONC file named `package.json`.
 */
function isPackageJson(document: TextDocument): boolean {
  return (
    document.fileName.endsWith("package.json") &&
    ["json", "jsonc"].includes(document.languageId)
  );
}

/**
 * Re-scans `editor`'s document for dependency lines, resolves each
 * package's update status (bounded by {@link MAX_CONCURRENT_LOOKUPS}
 * concurrent registry requests), and applies the resulting decorations.
 *
 * A no-op if the editor is no longer active by the time lookups resolve,
 * so a fast document switch during a slow lookup can't paint stale
 * decorations onto the wrong editor.
 * @param editor - The editor showing the `package.json` to annotate.
 */
async function updateDecorations(editor: TextEditor): Promise<void> {
  const document = editor.document;
  const matches = findDependencyLines(document);
  if (matches.length === 0) {
    return;
  }

  const results = await mapWithConcurrency(
    matches,
    MAX_CONCURRENT_LOOKUPS,
    async (match) => {
      const cached = await getCachedRegistryEntry(
        match.source,
        match.packageName,
      );
      const resolvedInstalledVersion =
        match.source === "node"
          ? match.installedVersion
          : resolveInstalledVersion(
              classifySpecifier(match.installedVersion),
              cached.distTags,
            );
      const bump = getBumpSeverity(
        resolvedInstalledVersion,
        cached.latestVersion,
      );
      return { match, bump, ...cached };
    },
  );

  if (editor !== window.activeTextEditor) {
    return;
  }

  const decorationsBySeverity: Record<BumpSeverity, DecorationOptions[]> = {
    major: [],
    minor: [],
    patch: [],
    none: [],
    unsupported: [],
  };

  for (const {
    match,
    bump,
    latestVersion,
    latestVersionPublishedAt,
  } of results) {
    if (!latestVersion || bump === "unsupported") {
      continue;
    }

    decorationsBySeverity[bump].push({
      range: match.range,
      renderOptions: {
        after: {
          contentText: contentFor(
            bump,
            latestVersion,
            latestVersionPublishedAt,
          ),
        },
      },
    });
  }

  for (const severity of Object.keys(decorationsBySeverity) as BumpSeverity[]) {
    editor.setDecorations(
      decorationTypes[severity],
      decorationsBySeverity[severity],
    );
  }
}

/**
 * Builds the annotation text shown at the end of a dependency line.
 *
 * Only called for `bump` values of `"major"`, `"minor"`, `"patch"`, or
 * `"none"` — {@link updateDecorations} skips `"unsupported"` lines before
 * reaching this function, since there's nothing meaningful to annotate.
 *
 * Exported for testing; not part of the extension's public API.
 * @param bump - The severity of the available update.
 * @param latestVersion - The latest version published to the registry.
 * @param latestVersionPublishedAt - ISO 8601 publish timestamp of `latestVersion`, if known.
 * @returns The annotation text, e.g. `"⬆ 7.9.1 (major) — 4 days ago"` or `"✓ up to date"`.
 */
export function contentFor(
  bump: Exclude<BumpSeverity, "unsupported">,
  latestVersion: string,
  latestVersionPublishedAt: string | undefined,
): string {
  if (bump === "none") {
    return "✓ up to date";
  }

  const publishedAgo = formatRelativeTime(latestVersionPublishedAt);
  const suffix = publishedAgo ? ` — ${publishedAgo}` : "";
  return `⬆ ${latestVersion} (${bump})${suffix}`;
}

/**
 * Resolves a package's (or Node.js's) latest version and its publish
 * timestamp, serving from {@link registryCache} when a fresh-enough entry
 * exists.
 * @param source - Which registry to resolve `packageName` against.
 * @param packageName - The npm package name to look up (ignored when `source` is `"node"`).
 * @returns The cached or freshly-fetched registry entry.
 */
async function getCachedRegistryEntry(
  source: LookupSource,
  packageName: string,
): Promise<CachedRegistryEntry> {
  const cacheKey = `${source}:${packageName}`;
  const cached = registryCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached;
  }

  const entry: CachedRegistryEntry = {
    ...(await fetchLatest(source, packageName)),
    expiresAt: Date.now() + CACHE_TTL_MS,
  };

  registryCache.set(cacheKey, entry);
  return entry;
}

/**
 * Fetches the latest version (and its publish date) for a single dependency
 * match, dispatching to the npm registry or the Node.js release index
 * depending on `source`.
 * @param source - Which registry to resolve `packageName` against.
 * @param packageName - The npm package name to look up (ignored when `source` is `"node"`).
 * @returns The latest version info, with fields `undefined` on any failure.
 */
async function fetchLatest(
  source: LookupSource,
  packageName: string,
): Promise<Omit<CachedRegistryEntry, "expiresAt">> {
  if (source === "node") {
    const latest = await getLatestNodeLts().catch(() => undefined);
    return {
      latestVersion: latest?.version,
      latestVersionPublishedAt: latest?.publishedAt,
      distTags: {},
    };
  }

  const metadata = await getRegistryMetadata(packageName).catch(
    () => undefined,
  );
  return {
    latestVersion: metadata?.latestVersion,
    latestVersionPublishedAt: metadata?.latestVersionPublishedAt,
    distTags: metadata?.distTags ?? {},
  };
}

/**
 * Maps `items` through `fn` with at most `concurrency` calls in flight at
 * once, preserving input order in the returned array.
 * @template T - The input item type.
 * @template R - The type each item is mapped to.
 * @param items - The items to process.
 * @param concurrency - The maximum number of concurrent `fn` calls.
 * @param fn - The async mapping function.
 * @returns The mapped results, in the same order as `items`.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) {
        return;
      }
      // Safe: index is bounds-checked above.
      results[index] = await fn(items[index] as T);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );

  return results;
}

/** Matches `"packageManager": "npm@12.0.1"` and captures the tool name and version. */
const PACKAGE_MANAGER_REGEX =
  /^\s*"packageManager"\s*:\s*"(npm|yarn|pnpm)@([^"]+)"/;

/** Matches `"node": "24.x"` and captures the version range. */
const ENGINES_NODE_REGEX = /^\s*"node"\s*:\s*"([^"]+)"/;

/**
 * Scans `document` line by line for every annotatable version specifier:
 * entries inside {@link DEPENDENCY_SECTION_KEYS} sections, `engines.node`,
 * and the top-level `packageManager` field. Tracks brace depth to know
 * which named section (if any) the current line is inside.
 *
 * This is a lightweight line-oriented scan rather than a full JSON parse —
 * adequate for well-formed `package.json` files, which is all this feature
 * needs to support.
 *
 * Exported for testing; not part of the extension's public API.
 * @param document - The `package.json` document to scan.
 * @returns Every entry found, with the range to annotate.
 */
export function findDependencyLines(document: TextDocument): DependencyMatch[] {
  const matches: DependencyMatch[] = [];
  let currentSection: string | undefined;
  let sectionDepth = 0;

  for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
    const text = document.lineAt(lineNumber).text;
    const trimmed = text.trim();
    const range = new Range(lineNumber, text.length, lineNumber, text.length);

    const sectionHeaderMatch = /^"([^"]+)"\s*:\s*\{/.exec(trimmed);
    if (sectionHeaderMatch) {
      if (currentSection) {
        sectionDepth++;
      } else {
        currentSection = sectionHeaderMatch[1];
        sectionDepth = 1;
      }
      continue;
    }

    if (currentSection) {
      if (trimmed === "}" || trimmed === "},") {
        sectionDepth--;
        if (sectionDepth <= 0) {
          currentSection = undefined;
        }
        continue;
      }

      if (currentSection === "engines") {
        const nodeMatch = ENGINES_NODE_REGEX.exec(text);
        const installedVersion = nodeMatch?.[1];
        if (installedVersion) {
          matches.push({
            packageName: "node",
            installedVersion,
            range,
            source: "node",
          });
        }
        continue;
      }

      if (DEPENDENCY_SECTION_KEYS.has(currentSection)) {
        const entryMatch = /^\s*"([^"]+)"\s*:\s*"([^"]+)"/.exec(text);
        const packageName = entryMatch?.[1];
        const installedVersion = entryMatch?.[2];
        if (packageName && installedVersion) {
          matches.push({ packageName, installedVersion, range, source: "npm" });
        }
      }
      continue;
    }

    const packageManagerMatch = PACKAGE_MANAGER_REGEX.exec(text);
    const packageName = packageManagerMatch?.[1];
    const installedVersion = packageManagerMatch?.[2];
    if (packageName && installedVersion) {
      matches.push({ packageName, installedVersion, range, source: "npm" });
    }
  }

  return matches;
}
