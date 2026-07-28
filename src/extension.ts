import {
  languages,
  window,
  workspace,
  type ExtensionContext,
  type TextDocument,
} from "vscode";
import { DependencyAnalyzer } from "./analysis/analyzer";
import { affectsSettings, getSettings } from "./config";
import { DependencyCodeLensProvider } from "./features/code-lens-provider";
import { registerCommands, runSaveChangesTask } from "./features/commands";
import { DependencyDecorations } from "./features/dependency-decorations";
import { DependencyDiagnostics } from "./features/diagnostics";
import { NpmHoverProvider } from "./features/hover-provider";
import { isManifest } from "./features/manifest-documents";
import { wasSelfInitiatedSave } from "./features/manifest-edits";
import { DependencyPanelView, PANEL_VIEW_ID } from "./features/panel-view";
import { DependencyStatusBar } from "./features/status-bar";
import { ViewState } from "./features/view-state";
import { parseManifest } from "./parse/package-document";

/** The languages a manifest can be opened as. */
const MANIFEST_LANGUAGES = ["json", "jsonc"];

/**
 * Extension entry point, invoked by VS Code when the extension activates
 * (see `activationEvents` in `package.json`).
 *
 * Everything is built around one {@link DependencyAnalyzer}: it owns the
 * fetching and caching, and each feature is a view onto its results, wired
 * to repaint whenever an analysis lands.
 * @param context - The extension context provided by VS Code, used to scope disposables to the extension's lifetime.
 */
export function activate(context: ExtensionContext): void {
  const analyzer = new DependencyAnalyzer();
  const viewState = new ViewState();
  const decorations = new DependencyDecorations(analyzer);
  const diagnostics = new DependencyDiagnostics(analyzer);
  const statusBar = new DependencyStatusBar(analyzer);
  const codeLens = new DependencyCodeLensProvider(analyzer, viewState);
  const panel = new DependencyPanelView(analyzer);
  const specifierSnapshots = new Map<string, string>();

  const repaint = (): void => {
    decorations.refreshAll();
    statusBar.refresh(window.activeTextEditor?.document);
    panel.render();
    codeLens.refresh();

    const document = window.activeTextEditor?.document;
    if (document) {
      diagnostics.refresh(document);
    }
  };

  const analyzeIfManifest = (
    document: TextDocument | undefined,
    force = false,
  ): void => {
    if (document && isManifest(document)) {
      void analyzer.analyze(document, force);
    }
  };

  context.subscriptions.push(
    analyzer,
    viewState,
    decorations,
    diagnostics,
    statusBar,
    codeLens,
    panel,

    languages.registerHoverProvider(
      MANIFEST_LANGUAGES,
      new NpmHoverProvider(analyzer),
    ),
    languages.registerCodeLensProvider(MANIFEST_LANGUAGES, codeLens),
    window.registerWebviewViewProvider(PANEL_VIEW_ID, panel),
    ...registerCommands({ analyzer, viewState }),

    analyzer.onDidChangeAnalysis(repaint),
    viewState.onDidChange(() => {
      codeLens.refresh();
    }),

    window.onDidChangeActiveTextEditor((editor) => {
      panel.setManifest(editor?.document);
      if (editor && isManifest(editor.document)) {
        // Record the specifiers on first sight, so the first save of this
        // manifest can be compared against something and isn't silently
        // exempt from the configured task. Only on first sight: re-recording
        // on every editor switch would swallow edits made before the switch.
        snapshotIfUnseen(editor.document, specifierSnapshots);
        if (getSettings(editor.document.uri).checkOnOpen) {
          analyzeIfManifest(editor.document);
        }
      }
      repaint();
    }),

    workspace.onDidSaveTextDocument((document) => {
      if (!isManifest(document)) {
        return;
      }

      // Read unconditionally: the mark has to be consumed on the save it
      // describes, or it survives to suppress the install on some later,
      // genuinely user-made save.
      const selfInitiated = wasSelfInitiatedSave(document.uri);

      // The snapshot is refreshed either way; only a save the user made
      // should trigger the configured install task, since an update applied
      // from a lens has already chosen whether to install.
      if (dependenciesChanged(document, specifierSnapshots) && !selfInitiated) {
        void runSaveChangesTask(document);
      }
      analyzeIfManifest(document);
    }),

    workspace.onDidCloseTextDocument((document) => {
      analyzer.forget(document.uri);
      diagnostics.clear(document);
      specifierSnapshots.delete(document.uri.toString());
    }),

    workspace.onDidChangeConfiguration((event) => {
      if (!affectsSettings((section) => event.affectsConfiguration(section))) {
        return;
      }
      analyzer.clearCache();
      analyzeIfManifest(window.activeTextEditor?.document, true);
      repaint();
    }),
  );

  const active = window.activeTextEditor?.document;
  if (active && isManifest(active)) {
    snapshot(active, specifierSnapshots);
    panel.setManifest(active);
    if (getSettings(active.uri).checkOnOpen) {
      analyzeIfManifest(active);
    }
  }
  statusBar.refresh(active);
}

/**
 * Extension deactivation hook, required by the VS Code extension API.
 * No-op: all cleanup is handled via disposables pushed onto
 * `context.subscriptions` during {@link activate}.
 */
export function deactivate(): void {
  // Intentionally empty.
}

/**
 * Checks whether a save changed any declared specifier, and records the new
 * state for the next comparison.
 *
 * This is what gates the custom install task: re-running an install on every
 * save of a manifest — including saves that only touched `scripts` — would
 * be intrusive, so the task runs only when a dependency actually moved.
 * @param document - The manifest that was saved.
 * @param snapshots - Per-manifest record of the last-seen specifiers.
 * @returns `true` if a specifier changed since the last recorded state.
 */
function dependenciesChanged(
  document: TextDocument,
  snapshots: Map<string, string>,
): boolean {
  const previous = snapshots.get(document.uri.toString());
  const current = snapshot(document, snapshots);

  return previous !== undefined && previous !== current;
}

/**
 * Records a manifest's specifiers unless they've already been recorded, so
 * a manifest is snapshotted as it was first seen rather than as it stands
 * after the user has edited it.
 * @param document - The manifest to record.
 * @param snapshots - The record to write into.
 */
function snapshotIfUnseen(
  document: TextDocument,
  snapshots: Map<string, string>,
): void {
  if (!snapshots.has(document.uri.toString())) {
    snapshot(document, snapshots);
  }
}

/**
 * Records a manifest's current specifiers as a single comparable string.
 * @param document - The manifest to record.
 * @param snapshots - The record to write into.
 * @returns The recorded snapshot.
 */
function snapshot(
  document: TextDocument,
  snapshots: Map<string, string>,
): string {
  const { entries } = parseManifest(
    document.getText(),
    getSettings(document.uri).dependencyProperties,
  );
  const value = entries
    .map((entry) => `${entry.section}/${entry.name}@${entry.specifier}`)
    .join("\n");

  snapshots.set(document.uri.toString(), value);
  return value;
}
