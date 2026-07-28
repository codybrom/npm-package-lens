import {
  CodeLens,
  Disposable,
  EventEmitter,
  type CodeLensProvider,
  type Event,
  type TextDocument,
} from "vscode";
import type {
  DependencyAnalyzer,
  ManifestAnalysis,
} from "../analysis/analyzer";
import { getSettings, type Settings } from "../config";
import {
  getVersionSuggestions,
  type VersionSuggestion,
} from "../npm/suggestions";
import type { DependencyStatus } from "../types";
import { COMMANDS, type UpdateDependencyArgs } from "./commands";
import { isManifest, toRange } from "./manifest-documents";
import { summarize, summaryText } from "./presentation";
import type { ViewState } from "./view-state";

/**
 * Shows version suggestions above each dependency, and a summary above each
 * dependency section.
 *
 * Suggestions that name a newer version are clickable and rewrite the
 * specifier in place; the rest are informational, describing what the
 * declared range resolves to today.
 */
export class DependencyCodeLensProvider
  implements CodeLensProvider, Disposable
{
  private readonly changeEmitter = new EventEmitter<void>();

  /** @inheritdoc */
  readonly onDidChangeCodeLenses: Event<void> = this.changeEmitter.event;

  /**
   * @param analyzer - The analyzer supplying dependency statuses.
   * @param viewState - The suggestion and prerelease visibility toggles.
   */
  constructor(
    private readonly analyzer: DependencyAnalyzer,
    private readonly viewState: ViewState,
  ) {}

  /** Asks VS Code to re-request lenses, e.g. after an analysis lands. */
  refresh(): void {
    this.changeEmitter.fire();
  }

  /** @inheritdoc */
  async provideCodeLenses(document: TextDocument): Promise<CodeLens[]> {
    if (!isManifest(document)) {
      return [];
    }

    const settings = getSettings(document.uri);
    if (!settings.codeLensEnabled && !settings.showSectionSummaries) {
      return [];
    }

    const cached = this.analyzer.get(document.uri);
    const analysis =
      cached?.documentVersion === document.version
        ? cached
        : await this.analyzer.analyze(document);

    const lenses: CodeLens[] = [];

    if (settings.showSectionSummaries) {
      lenses.push(...sectionLenses(document, analysis));
    }

    if (settings.codeLensEnabled && this.viewState.suggestionsVisible) {
      for (const status of analysis.statuses) {
        lenses.push(
          ...suggestionLenses(
            document,
            status,
            settings,
            this.viewState.prereleasesVisible,
          ),
        );
      }
    }

    return lenses;
  }

  /** @inheritdoc */
  dispose(): void {
    this.changeEmitter.dispose();
  }
}

/**
 * Builds the summary lens above each dependency section.
 * @param document - The manifest being annotated.
 * @param analysis - The analysis to summarize.
 * @returns One lens per section.
 */
function sectionLenses(
  document: TextDocument,
  analysis: ManifestAnalysis,
): CodeLens[] {
  return analysis.sections.map((section) => {
    const summary = summarize(
      analysis.statuses.filter(
        (status) => status.entry.section === section.path,
      ),
    );

    const range = toRange(document, section.nameRange);
    const title = summaryText(summary);

    // Only offer the bulk update when there's something to update; otherwise
    // the summary is a label, not a button.
    return summary.updates === 0
      ? new CodeLens(range, { title, command: "" })
      : new CodeLens(range, {
          title,
          command: COMMANDS.updateAll,
          arguments: [document.uri],
          tooltip: "Update every dependency in this file that isn't blocked",
        });
  });
}

/**
 * Builds the suggestion lenses for one dependency.
 * @param document - The manifest being annotated.
 * @param status - The analyzed dependency.
 * @param settings - The settings governing indicators and prerelease filtering.
 * @param includePrereleases - Whether prerelease suggestions are shown.
 * @returns One lens per suggestion, in display order.
 */
function suggestionLenses(
  document: TextDocument,
  status: DependencyStatus,
  settings: Settings,
  includePrereleases: boolean,
): CodeLens[] {
  const metadata = status.metadata;
  if (!metadata) {
    return [];
  }

  const suggestions = getVersionSuggestions({
    specifier: status.entry.specifier,
    versions: metadata.versions,
    distTags: metadata.distTags,
    includePrereleases,
    prereleaseTagFilter: settings.prereleaseTagFilter,
    currentIsVulnerable: status.vulnerabilities.length > 0,
    blockerCount: status.conflicts.length,
    updateSeverity: status.bump,
    includeUpToDate: settings.showUpToDateSuggestions,
  });

  const range = toRange(document, status.entry.nameRange);

  return suggestions.flatMap((suggestion) => {
    const title = `${settings.indicators[suggestion.status]} ${suggestion.label}`;

    if (
      suggestion.replacement === undefined ||
      suggestion.version === undefined
    ) {
      return [new CodeLens(range, { title, command: "" })];
    }

    const args: UpdateDependencyArgs = {
      uri: document.uri.toString(),
      span: status.entry.specifierRange,
      replacement: suggestion.replacement,
      name: status.entry.name,
      version: suggestion.version,
    };

    const update = new CodeLens(range, {
      title,
      command: COMMANDS.updateDependency,
      arguments: [args],
      tooltip: tooltipFor(status, suggestion, false),
    });

    // Only an update earns an install companion. Pinning the manifest to the
    // version already on disk is the other clickable case, and installing
    // after it would reconcile nothing.
    if (suggestion.kind !== "update") {
      return [update];
    }

    return [
      update,
      new CodeLens(range, {
        title:
          suggestion.status === "blocked"
            ? "Install Blocked Update"
            : "Install Update",
        command: COMMANDS.updateDependencyAndInstall,
        arguments: [args],
        tooltip: tooltipFor(status, suggestion, true),
      }),
    ];
  });
}

/**
 * Explains what clicking a suggestion does, warning when the update is one a
 * peer requirement objects to — the lens is still clickable, since npm's
 * `--legacy-peer-deps` and coordinated upgrades both make it a reasonable
 * thing to want.
 * @param status - The analyzed dependency.
 * @param suggestion - The suggestion this lens would apply.
 * @param install - Whether the action also runs the install step.
 * @returns The tooltip text.
 */
function tooltipFor(
  status: DependencyStatus,
  suggestion: VersionSuggestion,
  install: boolean,
): string {
  const target = suggestion.replacement ?? "";
  const action =
    suggestion.kind === "state"
      ? `Update Resolved — pin ${status.entry.name} to ${target}`
      : suggestion.status === "blocked"
        ? `Update Blocked — set ${status.entry.name} to ${target} despite the peer conflict`
        : `Set ${status.entry.name} to ${target}`;

  const parts = [install ? `${action} and run the install step` : action];

  // Worth saying plainly, since it's the difference between a real upgrade
  // and bookkeeping: the range already covers this version, so the edit
  // changes the manifest but not what an install produces.
  if (suggestion.satisfiedByRange && suggestion.version !== undefined) {
    parts.push(
      `the declared range already installs ${suggestion.version}, so this only updates package.json`,
    );
  }

  if (status.conflicts.length > 0) {
    const blockers = status.conflicts
      .map(
        (conflict) => `${conflict.blockedBy} (needs ${conflict.requiredRange})`,
      )
      .join(", ");
    parts.push(`blocked by ${blockers}`);
  }

  return parts.join(" — ");
}
