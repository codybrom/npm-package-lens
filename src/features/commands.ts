import { basename, dirname } from "node:path";
import {
  commands,
  Disposable,
  tasks,
  Uri,
  window,
  workspace,
  type TextDocument,
} from "vscode";
import type { DependencyAnalyzer } from "../analysis/analyzer";
import { getSettings } from "../config";
import { applyVersionToSpecifier } from "../npm/suggestions";
import { getVulnerabilities } from "../npm/vulnerabilities";
import type { OffsetRange } from "../parse/package-document";
import type { BumpSeverity, DependencyStatus } from "../types";
import { isManifest } from "./manifest-documents";
import {
  applySpecifierEdits,
  sortDependencySections,
  type SpecifierEdit,
} from "./manifest-edits";
import { isUpdatable } from "./presentation";
import type { ViewState } from "./view-state";

/** Every command this extension contributes, by ID. */
export const COMMANDS = {
  checkUpdates: "npmPackageLens.checkUpdates",
  refresh: "npmPackageLens.refresh",
  showSuggestions: "npmPackageLens.showSuggestions",
  hideSuggestions: "npmPackageLens.hideSuggestions",
  showPrereleases: "npmPackageLens.showPrereleases",
  hidePrereleases: "npmPackageLens.hidePrereleases",
  updateDependency: "npmPackageLens.updateDependency",
  updateDependencyAndInstall: "npmPackageLens.updateDependencyAndInstall",
  updateAll: "npmPackageLens.updateAll",
  updateMajor: "npmPackageLens.updateMajor",
  updateMinor: "npmPackageLens.updateMinor",
  updatePatch: "npmPackageLens.updatePatch",
  sortDependencies: "npmPackageLens.sortDependencies",
  runInstall: "npmPackageLens.runInstall",
} as const;

/**
 * Arguments for {@link COMMANDS.updateDependency} and
 * {@link COMMANDS.updateDependencyAndInstall}, as passed from a CodeLens or
 * the panel.
 */
export interface UpdateDependencyArgs {
  /** The manifest to edit, as a string so it survives command-link serialization. */
  uri: string;
  /** The specifier span to rewrite. */
  span: OffsetRange;
  /** The specifier text to write. */
  replacement: string;
  /** The package being updated, for the vulnerability check. */
  name: string;
  /** The concrete version being moved to, for the vulnerability check. */
  version: string;
}

/** What the command handlers need from the rest of the extension. */
export interface CommandContext {
  /** The analyzer, for reading statuses and forcing re-analysis. */
  analyzer: DependencyAnalyzer;
  /** The suggestion/prerelease toggles. */
  viewState: ViewState;
}

/**
 * Registers every command this extension contributes.
 * @param context - The analyzer and view state the handlers operate on.
 * @returns Disposables for each registered command.
 */
export function registerCommands(context: CommandContext): Disposable[] {
  const { analyzer, viewState } = context;

  return [
    commands.registerCommand(COMMANDS.checkUpdates, async () => {
      await analyzeActiveManifest(analyzer, false);
    }),
    commands.registerCommand(COMMANDS.refresh, async () => {
      await analyzeActiveManifest(analyzer, true);
    }),
    commands.registerCommand(COMMANDS.showSuggestions, () => {
      viewState.setSuggestionsVisible(true);
    }),
    commands.registerCommand(COMMANDS.hideSuggestions, () => {
      viewState.setSuggestionsVisible(false);
    }),
    commands.registerCommand(COMMANDS.showPrereleases, () => {
      viewState.setPrereleasesVisible(true);
    }),
    commands.registerCommand(COMMANDS.hidePrereleases, () => {
      viewState.setPrereleasesVisible(false);
    }),
    commands.registerCommand(
      COMMANDS.updateDependency,
      async (args: UpdateDependencyArgs) => {
        await updateDependency(analyzer, args, false);
      },
    ),
    commands.registerCommand(
      COMMANDS.updateDependencyAndInstall,
      async (args: UpdateDependencyArgs) => {
        await updateDependency(analyzer, args, true);
      },
    ),
    commands.registerCommand(COMMANDS.updateAll, async (target?: Uri) => {
      await updateMatching(analyzer, target, () => true, "latest");
    }),
    commands.registerCommand(COMMANDS.updateMajor, async (target?: Uri) => {
      await updateMatching(analyzer, target, isBump("major"), "major");
    }),
    commands.registerCommand(COMMANDS.updateMinor, async (target?: Uri) => {
      await updateMatching(analyzer, target, isBump("minor"), "minor");
    }),
    commands.registerCommand(COMMANDS.updatePatch, async (target?: Uri) => {
      await updateMatching(analyzer, target, isBump("patch"), "patch");
    }),
    commands.registerCommand(COMMANDS.sortDependencies, async () => {
      await sortActiveManifest(analyzer);
    }),
    commands.registerCommand(COMMANDS.runInstall, async (target?: Uri) => {
      const document = await resolveManifest(target);
      if (document) {
        await runInstall(document);
      }
    }),
  ];
}

/**
 * Builds a predicate selecting dependencies whose available update is of a
 * particular severity.
 * @param bump - The severity to select.
 * @returns The predicate.
 */
function isBump(bump: BumpSeverity): (status: DependencyStatus) => boolean {
  return (status) => status.bump === bump;
}

/**
 * Re-analyzes the manifest in the active editor.
 * @param analyzer - The analyzer to run.
 * @param force - Whether to clear cached registry data first.
 */
async function analyzeActiveManifest(
  analyzer: DependencyAnalyzer,
  force: boolean,
): Promise<void> {
  const document = await resolveManifest(undefined);
  if (!document) {
    window.showInformationMessage(
      "Open a package.json to check for dependency updates.",
    );
    return;
  }

  await analyzer.analyze(document, force);
}

/**
 * Applies a single dependency update, after confirming any update that would
 * move onto a version with a known advisory.
 *
 * Whether to install afterwards is the caller's choice rather than a
 * setting: editing the manifest and reconciling `node_modules` are separate
 * decisions, and which one you want depends on whether you're about to
 * change three more lines.
 * @param analyzer - The analyzer, re-run once the edit lands.
 * @param args - The update to apply.
 * @param install - Whether to run the install step after the edit.
 */
async function updateDependency(
  analyzer: DependencyAnalyzer,
  args: UpdateDependencyArgs,
  install: boolean,
): Promise<void> {
  const document = await workspace.openTextDocument(Uri.parse(args.uri));

  if (!(await confirmIfVulnerable(args.name, args.version))) {
    return;
  }

  const applied = await applySpecifierEdits(document, [
    { span: args.span, replacement: args.replacement },
  ]);
  if (!applied) {
    return;
  }

  if (install) {
    await runInstall(document);
  }
  await analyzer.analyze(document);
}

/**
 * Updates every dependency in a manifest whose available update matches
 * `predicate`, skipping the ones a peer requirement blocks.
 *
 * Blocked updates are reported rather than silently dropped: "9 of 11
 * updated" without saying why the other two weren't would read as a bug.
 * @param analyzer - The analyzer supplying statuses and re-run afterwards.
 * @param target - The manifest to update, or `undefined` for the active editor's.
 * @param predicate - Selects which updates to apply.
 * @param label - How to describe the update set in messages.
 */
async function updateMatching(
  analyzer: DependencyAnalyzer,
  target: Uri | undefined,
  predicate: (status: DependencyStatus) => boolean,
  label: string,
): Promise<void> {
  const document = await resolveManifest(target);
  if (!document) {
    return;
  }

  const analysis = await analyzer.analyze(document);
  const candidates = analysis.statuses.filter(
    (status) => isUpdatable(status.bump) && predicate(status),
  );
  const blocked = candidates.filter((status) => status.conflicts.length > 0);
  const applicable = candidates.filter(
    (status) => status.conflicts.length === 0,
  );

  const edits: SpecifierEdit[] = applicable.flatMap((status) => {
    if (status.latestVersion === undefined) {
      return [];
    }

    const replacement = applyVersionToSpecifier(
      status.entry.specifier,
      status.latestVersion,
    );
    // A specifier no single version substitution preserves — a wildcard, or
    // a compound range like `>=1 <2` — comes back unchanged rather than
    // silently losing half of what the author wrote. There's nothing to
    // apply for those.
    return replacement === status.entry.specifier.trim()
      ? []
      : [{ span: status.entry.specifierRange, replacement }];
  });

  if (edits.length === 0) {
    window.showInformationMessage(
      blocked.length > 0
        ? `No ${label} updates can be applied — ${blocked.length.toString()} blocked by peer dependencies.`
        : `No ${label} updates available.`,
    );
    return;
  }

  if (!(await applySpecifierEdits(document, edits))) {
    return;
  }

  const skipped =
    blocked.length > 0
      ? `, ${blocked.length.toString()} skipped (blocked by peer dependencies)`
      : "";
  window.showInformationMessage(
    `Updated ${edits.length.toString()} ${label === "latest" ? "dependencies" : `${label} versions`}${skipped}.`,
  );

  if (getSettings(document.uri).runInstallAfterUpgrade) {
    await runInstall(document);
  }
  await analyzer.analyze(document);
}

/**
 * Sorts every dependency section of the active manifest alphabetically.
 * @param analyzer - The analyzer, consulted for which sections exist.
 */
async function sortActiveManifest(analyzer: DependencyAnalyzer): Promise<void> {
  const document = await resolveManifest(undefined);
  if (!document) {
    return;
  }

  const analysis =
    analyzer.get(document.uri) ?? (await analyzer.analyze(document));
  await sortDependencySections(
    document,
    analysis.sections.map((section) => section.path),
  );
}

/**
 * Asks for confirmation before moving onto a version with a known advisory.
 *
 * A failed lookup answers "yes": an update shouldn't be blocked because the
 * advisory database was unreachable.
 * @param name - The package being updated.
 * @param version - The version being moved to.
 * @returns `true` if the update should proceed.
 */
async function confirmIfVulnerable(
  name: string,
  version: string,
): Promise<boolean> {
  const settings = getSettings();
  if (!settings.checkVulnerabilities) {
    return true;
  }

  const advisories = await getVulnerabilities([{ name, version }]).catch(
    () => undefined,
  );
  const found = advisories?.get(`${name}@${version}`) ?? [];
  if (found.length === 0) {
    return true;
  }

  const summary = found
    .map((advisory) => advisory.summary ?? advisory.id)
    .join("; ");
  const choice = await window.showWarningMessage(
    `${name}@${version} has ${found.length.toString()} known ${found.length === 1 ? "advisory" : "advisories"}: ${summary}`,
    { modal: true },
    "Update anyway",
  );

  return choice === "Update anyway";
}

/**
 * Runs the project's install step after a manifest edit — the configured
 * `tasks.json` task if one is named, otherwise `npm install` in a terminal.
 * @param document - The manifest that changed.
 */
export async function runInstall(document: TextDocument): Promise<void> {
  if (await runConfiguredTask(document)) {
    return;
  }

  // One terminal per project directory: reusing a terminal by name alone
  // would install into whichever directory it was opened for, which is the
  // wrong one as soon as a monorepo has a second manifest.
  const cwd = dirname(document.uri.fsPath);
  const name = `npm install — ${basename(cwd)}`;
  const terminal =
    window.terminals.find(
      (candidate) =>
        candidate.name === name && candidate.exitStatus === undefined,
    ) ?? window.createTerminal({ name, cwd });
  terminal.sendText("npm install");
  terminal.show(true);
}

/**
 * Runs the install step for a manifest the *user* saved.
 *
 * Only the configured `tasks.json` task runs here. Saving a manifest is an
 * ordinary editing action, and spawning an install off the back of one the
 * user didn't ask for is intrusive — so the fallback to `npm install` in a
 * terminal is reserved for the explicit update actions, where installing is
 * what was clicked.
 * @param document - The manifest that was saved.
 */
export async function runSaveChangesTask(
  document: TextDocument,
): Promise<void> {
  await runConfiguredTask(document);
}

/**
 * Runs the task named by `npmPackageLens.onSaveChanges`, if one is
 * configured.
 * @param document - The manifest the settings are read for.
 * @returns `true` if a task was configured, whether or not it could be found — the caller should not fall back in that case, since a named task that's missing is a configuration error worth surfacing rather than papering over.
 */
async function runConfiguredTask(document: TextDocument): Promise<boolean> {
  const { onSaveChangesTask } = getSettings(document.uri);
  if (onSaveChangesTask === undefined) {
    return false;
  }

  const available = await tasks.fetchTasks();
  const task = available.find(
    (candidate) => candidate.name === onSaveChangesTask,
  );
  if (task) {
    await tasks.executeTask(task);
    return true;
  }

  window.showWarningMessage(
    `No task named "${onSaveChangesTask}" was found. Define it in tasks.json or clear npmPackageLens.onSaveChanges.`,
  );
  return true;
}

/**
 * Resolves the manifest a command should act on.
 * @param target - An explicit manifest URI, or `undefined` to use the active editor.
 * @returns The manifest document, or `undefined` if there isn't one.
 */
async function resolveManifest(
  target: Uri | undefined,
): Promise<TextDocument | undefined> {
  if (target) {
    return workspace.openTextDocument(target);
  }

  const document = window.activeTextEditor?.document;
  return document && isManifest(document) ? document : undefined;
}
