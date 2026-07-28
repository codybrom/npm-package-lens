import {
  DecorationOptions,
  DecorationRangeBehavior,
  Disposable,
  TextEditor,
  TextEditorDecorationType,
  ThemeColor,
  window,
} from "vscode";
import type { DependencyAnalyzer } from "../analysis/analyzer";
import { getSettings } from "../config";
import { endOfLineRange, isManifest } from "./manifest-documents";
import {
  annotationFor,
  displayStateOf,
  themeColorId,
  type DisplayState,
} from "./presentation";

/** The display states an annotation can actually be rendered in. */
const RENDERED_STATES: DisplayState[] = [
  "vulnerable",
  "blocked",
  "deprecated",
  "major",
  "minor",
  "patch",
  "upToDate",
];

/**
 * Renders each dependency's status as an end-of-line annotation, in the
 * theme color matching its severity.
 *
 * Annotations are painted from whatever the analyzer last computed, so the
 * feature owns no fetching of its own: a manifest that has been analyzed
 * paints immediately, and one that hasn't paints as soon as the analysis
 * lands.
 */
export class DependencyDecorations implements Disposable {
  private readonly decorationTypes = new Map<
    DisplayState,
    TextEditorDecorationType
  >(
    RENDERED_STATES.map((state) => [
      state,
      createDecorationType(themeColorId(state)),
    ]),
  );

  /**
   * @param analyzer - The analyzer supplying dependency statuses.
   */
  constructor(private readonly analyzer: DependencyAnalyzer) {}

  /**
   * Repaints every visible editor showing a manifest, clearing annotations
   * from any editor the feature has been switched off for.
   */
  refreshAll(): void {
    for (const editor of window.visibleTextEditors) {
      this.refresh(editor);
    }
  }

  /**
   * Repaints one editor from the analyzer's current view of its document.
   * @param editor - The editor to repaint.
   */
  refresh(editor: TextEditor): void {
    if (!isManifest(editor.document)) {
      return;
    }

    const { decorationsEnabled, showUpToDate } = getSettings(
      editor.document.uri,
    );
    const analysis = this.analyzer.get(editor.document.uri);

    const byState = new Map<DisplayState, DecorationOptions[]>(
      RENDERED_STATES.map((state) => [state, []]),
    );

    // A stale analysis would anchor annotations to offsets the user has
    // already edited past, so an edited document shows nothing until its
    // next pass completes.
    const isCurrent = analysis?.documentVersion === editor.document.version;

    if (decorationsEnabled && isCurrent) {
      for (const status of analysis.statuses) {
        const text = annotationFor(status, showUpToDate);
        if (text === undefined) {
          continue;
        }

        byState.get(displayStateOf(status))?.push({
          range: endOfLineRange(
            editor.document,
            status.entry.specifierRange.start,
          ),
          renderOptions: { after: { contentText: text } },
        });
      }
    }

    for (const [state, decorations] of byState) {
      const type = this.decorationTypes.get(state);
      if (type) {
        editor.setDecorations(type, decorations);
      }
    }
  }

  /** @inheritdoc */
  dispose(): void {
    for (const type of this.decorationTypes.values()) {
      type.dispose();
    }
    this.decorationTypes.clear();
  }
}

/**
 * Creates a decoration type that renders an `after`-text annotation in the
 * given theme color.
 * @param colorId - A VS Code theme color identifier (e.g. `"errorForeground"`).
 * @returns A disposable decoration type; the caller owns its disposal.
 */
function createDecorationType(colorId: string): TextEditorDecorationType {
  return window.createTextEditorDecorationType({
    after: {
      margin: "0 0 0 1rem",
      color: new ThemeColor(colorId),
    },
    // Annotations sit past end-of-line; without this they widen to swallow
    // text typed at the very end of the line they're attached to.
    rangeBehavior: DecorationRangeBehavior.ClosedOpen,
  });
}
