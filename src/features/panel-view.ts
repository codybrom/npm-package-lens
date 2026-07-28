import {
  commands,
  Disposable,
  Range,
  Selection,
  Uri,
  window,
  workspace,
  type CancellationToken,
  type TextDocument,
  type WebviewView,
  type WebviewViewProvider,
  type WebviewViewResolveContext,
} from "vscode";
import type { DependencyAnalyzer } from "../analysis/analyzer";
import { applyVersionToSpecifier } from "../npm/suggestions";
import type { DependencyStatus } from "../types";
import { COMMANDS, type UpdateDependencyArgs } from "./commands";
import { isManifest } from "./manifest-documents";
import {
  displayStateOf,
  summarize,
  summaryText,
  type DisplayState,
} from "./presentation";

/** The view ID this provider is registered under, matching `package.json`. */
export const PANEL_VIEW_ID = "npmPackageLens.panel";

/** A message the webview sends back to the extension. */
type PanelMessage =
  | { type: "refresh" }
  | { type: "upgradeAll" }
  | { type: "upgradePatches" }
  | { type: "upgrade"; name: string; section: string }
  | { type: "upgradeInstall"; name: string; section: string }
  | { type: "reveal"; name: string; section: string };

/**
 * A dashboard of the active manifest's dependencies, grouped by section,
 * with per-package and bulk upgrade actions.
 *
 * The panel is a view onto the same analysis the editor annotations use, so
 * opening it costs nothing beyond rendering — and it follows the active
 * editor, so switching between manifests in a monorepo switches what it
 * shows.
 */
export class DependencyPanelView implements WebviewViewProvider, Disposable {
  private view: WebviewView | undefined;
  private manifest: Uri | undefined;
  private readonly disposables: Disposable[] = [];

  /**
   * @param analyzer - The analyzer supplying dependency statuses.
   */
  constructor(private readonly analyzer: DependencyAnalyzer) {}

  /** @inheritdoc */
  resolveWebviewView(
    view: WebviewView,
    _context: WebviewViewResolveContext,
    _token: CancellationToken,
  ): void {
    this.view = view;
    view.webview.options = { enableScripts: true };

    this.disposables.push(
      view.webview.onDidReceiveMessage((message: PanelMessage) => {
        void this.handle(message);
      }),
      view.onDidDispose(() => {
        this.view = undefined;
      }),
    );

    this.render();
  }

  /**
   * Points the panel at a manifest and repaints it.
   * @param document - The manifest to show, or `undefined` if the active editor isn't one.
   */
  setManifest(document: TextDocument | undefined): void {
    if (document && !isManifest(document)) {
      return;
    }

    this.manifest = document?.uri;
    this.render();
  }

  /** Repaints the panel from the analyzer's current state. */
  render(): void {
    if (!this.view) {
      return;
    }

    const analysis = this.manifest
      ? this.analyzer.get(this.manifest)
      : undefined;

    this.view.webview.html = renderPanel(
      analysis?.statuses ?? [],
      this.manifest,
    );
  }

  /** @inheritdoc */
  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }

  /**
   * Dispatches a message from the webview to the matching command.
   * @param message - The message received.
   */
  private async handle(message: PanelMessage): Promise<void> {
    const uri = this.manifest;
    if (!uri) {
      return;
    }

    switch (message.type) {
      case "refresh":
        await commands.executeCommand(COMMANDS.refresh);
        return;
      case "upgradeAll":
        await commands.executeCommand(COMMANDS.updateAll, uri);
        return;
      case "upgradePatches":
        await commands.executeCommand(COMMANDS.updatePatch, uri);
        return;
      case "upgrade":
        await this.upgradeOne(uri, message.name, message.section, false);
        return;
      case "upgradeInstall":
        await this.upgradeOne(uri, message.name, message.section, true);
        return;
      case "reveal":
        await this.reveal(uri, message.name, message.section);
    }
  }

  /**
   * Upgrades a single package to its newest version.
   * @param uri - The manifest to edit.
   * @param name - The package to upgrade.
   * @param section - The section it's declared in, so duplicates across sections stay distinct.
   * @param install - Whether to run the install step after the edit.
   */
  private async upgradeOne(
    uri: Uri,
    name: string,
    section: string,
    install: boolean,
  ): Promise<void> {
    const status = this.find(uri, name, section);
    if (!status?.latestVersion) {
      return;
    }

    const replacement = applyVersionToSpecifier(
      status.entry.specifier,
      status.latestVersion,
    );
    // Nothing to write: the specifier is one no single version substitution
    // preserves, such as a wildcard or a compound range.
    if (replacement === status.entry.specifier.trim()) {
      return;
    }

    const args: UpdateDependencyArgs = {
      uri: uri.toString(),
      span: status.entry.specifierRange,
      replacement,
      name,
      version: status.latestVersion,
    };

    await commands.executeCommand(
      install ? COMMANDS.updateDependencyAndInstall : COMMANDS.updateDependency,
      args,
    );
  }

  /**
   * Opens the manifest and moves the cursor to a dependency's declaration.
   * @param uri - The manifest to open.
   * @param name - The package to reveal.
   * @param section - The section it's declared in.
   */
  private async reveal(uri: Uri, name: string, section: string): Promise<void> {
    const status = this.find(uri, name, section);
    if (!status) {
      return;
    }

    const document = await workspace.openTextDocument(uri);
    const editor = await window.showTextDocument(document);
    const position = document.positionAt(status.entry.nameRange.start);
    editor.selection = new Selection(position, position);
    editor.revealRange(new Range(position, position));
  }

  /**
   * Looks up one analyzed dependency.
   * @param uri - The manifest it belongs to.
   * @param name - The package name.
   * @param section - The section it's declared in.
   * @returns The status, or `undefined` if the analysis no longer contains it.
   */
  private find(
    uri: Uri,
    name: string,
    section: string,
  ): DependencyStatus | undefined {
    return this.analyzer
      .get(uri)
      ?.statuses.find(
        (status) =>
          status.entry.name === name && status.entry.section === section,
      );
  }
}

/** Human-readable labels for each display state, used in the panel's badges. */
const STATE_LABELS: Record<DisplayState, string> = {
  vulnerable: "vulnerable",
  blocked: "blocked",
  deprecated: "deprecated",
  major: "major",
  minor: "minor",
  patch: "patch",
  upToDate: "up to date",
  unknown: "—",
};

/**
 * Renders the panel's HTML.
 *
 * Exported for testing; not part of the extension's public API.
 * @param statuses - The analyzed dependencies to show.
 * @param manifest - The manifest being shown, if any.
 * @returns A complete HTML document.
 */
export function renderPanel(
  statuses: DependencyStatus[],
  manifest: Uri | undefined,
): string {
  const body =
    manifest === undefined
      ? `<p class="empty">Open a <code>package.json</code> to see its dependencies.</p>`
      : statuses.length === 0
        ? `<p class="empty">Checking dependencies…</p>`
        : renderSections(statuses);

  const summary = summarize(statuses);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>${PANEL_STYLES}</style>
</head>
<body>
<header>
  <p class="summary">${escapeHtml(summaryText(summary))}</p>
  <div class="actions">
    <button data-action="upgradeAll"${summary.updates === 0 ? " disabled" : ""}>Upgrade all</button>
    <button data-action="upgradePatches">Patches only</button>
    <button data-action="refresh">Refresh</button>
  </div>
</header>
${body}
<script>${PANEL_SCRIPT}</script>
</body>
</html>`;
}

/**
 * Renders one table per dependency section, in the order the sections appear
 * in the manifest.
 * @param statuses - The analyzed dependencies.
 * @returns The tables' HTML.
 */
function renderSections(statuses: DependencyStatus[]): string {
  const bySection = new Map<string, DependencyStatus[]>();
  for (const status of statuses) {
    const existing = bySection.get(status.entry.section);
    if (existing) {
      existing.push(status);
    } else {
      bySection.set(status.entry.section, [status]);
    }
  }

  return [...bySection]
    .map(
      ([section, entries]) => `<section>
  <h2>${escapeHtml(section)}</h2>
  <table>${entries.map(renderRow).join("")}</table>
</section>`,
    )
    .join("");
}

/**
 * Renders one dependency as a table row, followed by a details row when
 * there's something worth explaining — a blocker or an advisory.
 * @param status - The analyzed dependency.
 * @returns The row's HTML.
 */
function renderRow(status: DependencyStatus): string {
  const state = displayStateOf(status);
  const name = escapeHtml(status.entry.name);
  const section = escapeHtml(status.entry.section);
  const canUpgrade =
    status.latestVersion !== undefined &&
    state !== "upToDate" &&
    state !== "unknown" &&
    applyVersionToSpecifier(status.entry.specifier, status.latestVersion) !==
      status.entry.specifier.trim();

  const details = renderDetails(status);

  return `<tr class="state-${state}">
  <td class="name"><a data-action="reveal" data-name="${name}" data-section="${section}">${name}</a></td>
  <td class="current">${escapeHtml(status.entry.specifier)}</td>
  <td class="latest">${escapeHtml(status.latestVersion ?? "—")}</td>
  <td class="badge"><span class="badge-${state}">${escapeHtml(STATE_LABELS[state])}</span></td>
  <td class="action">${
    canUpgrade
      ? `<button data-action="upgrade" data-name="${name}" data-section="${section}">Upgrade</button>` +
        `<button class="secondary" title="Upgrade and run the install step" data-action="upgradeInstall" data-name="${name}" data-section="${section}">⇩</button>`
      : ""
  }</td>
</tr>${
    details === undefined
      ? ""
      : `<tr class="details"><td colspan="5">${details}</td></tr>`
  }`;
}

/**
 * Renders the explanatory lines beneath a row: what's blocking an upgrade,
 * and what advisories affect the version in use.
 * @param status - The analyzed dependency.
 * @returns The details HTML, or `undefined` if there's nothing to explain.
 */
function renderDetails(status: DependencyStatus): string | undefined {
  const lines: string[] = [];

  for (const conflict of status.conflicts) {
    const remedy = conflict.resolvedByUpgradingBlocker
      ? "upgrading it too would resolve this"
      : "its latest release still requires the older range";
    lines.push(
      `✋ Blocked by <strong>${escapeHtml(conflict.blockedBy)}@${escapeHtml(conflict.blockerVersion)}</strong>, which needs <code>${escapeHtml(conflict.requiredRange)}</code> — ${remedy}.`,
    );
  }

  for (const vulnerability of status.vulnerabilities) {
    const fix =
      vulnerability.fixedVersion === undefined
        ? ""
        : ` Fixed in ${escapeHtml(vulnerability.fixedVersion)}.`;
    lines.push(
      `⚠ <strong>${escapeHtml(vulnerability.id)}</strong> ${escapeHtml(vulnerability.summary ?? "Security advisory")}.${fix}`,
    );
  }

  if (status.deprecation !== undefined) {
    lines.push(`⊘ Deprecated: ${escapeHtml(status.deprecation)}`);
  }

  return lines.length === 0 ? undefined : lines.join("<br>");
}

/**
 * Escapes text before it lands in the panel's HTML. Package names,
 * specifiers, deprecation notices, and advisory summaries all originate
 * outside the extension.
 * @param text - The untrusted text.
 * @returns The escaped text.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The panel's stylesheet, written against VS Code's theme variables. */
const PANEL_STYLES = `
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 0 8px 12px; }
header { position: sticky; top: 0; background: var(--vscode-sideBar-background); padding: 8px 0; }
.summary { margin: 0 0 6px; font-weight: 600; }
.actions { display: flex; gap: 4px; flex-wrap: wrap; }
button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 3px 8px; border-radius: 2px; cursor: pointer; font-size: inherit; font-family: inherit; }
button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
button:disabled { opacity: 0.5; cursor: default; }
h2 { font-size: inherit; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.7; margin: 14px 0 4px; }
table { width: 100%; border-collapse: collapse; }
td { padding: 2px 4px 2px 0; vertical-align: baseline; }
.name a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
.name a:hover { text-decoration: underline; }
.current, .latest { font-family: var(--vscode-editor-font-family); opacity: 0.85; }
.action { text-align: right; white-space: nowrap; }
.action button + button { margin-left: 3px; }
button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
button.secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
.details td { padding: 0 4px 6px 0; opacity: 0.85; font-size: 0.95em; }
.empty { opacity: 0.7; }
[class^="badge-"] { font-size: 0.85em; padding: 0 5px; border-radius: 8px; white-space: nowrap; }
.badge-major, .badge-vulnerable, .badge-blocked { background: var(--vscode-inputValidation-errorBackground); }
.badge-minor, .badge-deprecated { background: var(--vscode-inputValidation-warningBackground); }
.badge-patch { background: var(--vscode-inputValidation-infoBackground); }
.badge-upToDate, .badge-unknown { opacity: 0.6; }
`;

/** The panel's script: forwards every action click to the extension. */
const PANEL_SCRIPT = `
const vscode = acquireVsCodeApi();
document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) { return; }
  vscode.postMessage({
    type: target.dataset.action,
    name: target.dataset.name,
    section: target.dataset.section,
  });
});
`;
