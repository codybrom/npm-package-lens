import {
  Disposable,
  StatusBarAlignment,
  ThemeColor,
  window,
  type StatusBarItem,
  type TextDocument,
} from "vscode";
import type { DependencyAnalyzer } from "../analysis/analyzer";
import { getSettings } from "../config";
import { isManifest } from "./manifest-documents";
import { summarize, type DependencySummary } from "./presentation";
import { COMMANDS } from "./commands";

/** Where the item sits relative to other status bar entries. */
const PRIORITY = 100;

/**
 * Summarizes the active manifest in the status bar — how many updates are
 * available, how many are blocked, and how many packages carry advisories —
 * so the state of a project is visible without scrolling its manifest.
 *
 * The item hides entirely when the active editor isn't a manifest, rather
 * than showing a stale count for a file the user has navigated away from.
 */
export class DependencyStatusBar implements Disposable {
  private readonly item: StatusBarItem = window.createStatusBarItem(
    StatusBarAlignment.Right,
    PRIORITY,
  );

  /**
   * @param analyzer - The analyzer supplying dependency statuses.
   */
  constructor(private readonly analyzer: DependencyAnalyzer) {
    this.item.command = COMMANDS.refresh;
  }

  /**
   * Repaints the item for the given manifest, or hides it if there isn't one.
   * @param document - The active document, if any.
   */
  refresh(document: TextDocument | undefined): void {
    if (!document || !isManifest(document)) {
      this.item.hide();
      return;
    }

    if (!getSettings(document.uri).statusBarEnabled) {
      this.item.hide();
      return;
    }

    const analysis = this.analyzer.get(document.uri);
    if (!analysis) {
      this.item.text = "$(sync~spin) npm";
      this.item.tooltip = "Checking dependencies…";
      this.item.backgroundColor = undefined;
      this.item.show();
      return;
    }

    const summary = summarize(analysis.statuses);
    this.item.text = statusText(summary);
    this.item.tooltip = statusTooltip(summary);
    this.item.backgroundColor =
      summary.vulnerable > 0 || summary.blocked > 0
        ? new ThemeColor("statusBarItem.warningBackground")
        : undefined;
    this.item.show();
  }

  /** @inheritdoc */
  dispose(): void {
    this.item.dispose();
  }
}

/**
 * Builds the compact status bar label.
 * @param summary - The counts to describe.
 * @returns A short label, e.g. `"npm 5↑ 1✋ 2⚠"`.
 */
function statusText(summary: DependencySummary): string {
  const parts: string[] = [];
  if (summary.updates > 0) {
    parts.push(`${summary.updates.toString()}↑`);
  }
  if (summary.blocked > 0) {
    parts.push(`${summary.blocked.toString()}✋`);
  }
  if (summary.vulnerable > 0) {
    parts.push(`${summary.vulnerable.toString()}⚠`);
  }

  return parts.length === 0
    ? "$(check) npm"
    : `$(package) npm ${parts.join(" ")}`;
}

/**
 * Spells the counts out in full for the hover tooltip, where there's room.
 * @param summary - The counts to describe.
 * @returns The tooltip text.
 */
function statusTooltip(summary: DependencySummary): string {
  const lines = [
    `${summary.updates.toString()} update${summary.updates === 1 ? "" : "s"} available`,
    `${summary.blocked.toString()} blocked by peer dependencies`,
    `${summary.vulnerable.toString()} with known advisories`,
    `${summary.upToDate.toString()} up to date`,
  ];

  return `${lines.join("\n")}\n\nClick to re-check (clears the cache)`;
}
