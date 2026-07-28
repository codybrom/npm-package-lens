import { commands, Disposable, EventEmitter, type Event } from "vscode";
import { getSettings } from "../config";

/** Context keys mirrored into `when` clauses so the toolbar icons can toggle. */
const CONTEXT_KEYS = {
  suggestions: "npmPackageLens.suggestionsVisible",
  prereleases: "npmPackageLens.prereleasesVisible",
} as const;

/**
 * The two view toggles that aren't settings: whether version suggestions and
 * prerelease suggestions are currently showing.
 *
 * They start from the corresponding "on startup" settings and are flipped
 * from the editor toolbar, so they're session state rather than
 * configuration — and they're mirrored into VS Code context keys so the
 * toolbar can show "show" or "hide" as appropriate.
 */
export class ViewState implements Disposable {
  private readonly changeEmitter = new EventEmitter<void>();
  private suggestions: boolean;
  private prereleases: boolean;

  /** Fires whenever either toggle changes. */
  readonly onDidChange: Event<void> = this.changeEmitter.event;

  /**
   *
   */
  constructor() {
    const settings = getSettings();
    this.suggestions = settings.showSuggestionsOnStartup;
    this.prereleases = settings.showPrereleasesOnStartup;
    this.syncContextKeys();
  }

  /** @returns Whether version suggestions are currently shown. */
  get suggestionsVisible(): boolean {
    return this.suggestions;
  }

  /** @returns Whether prerelease suggestions are currently shown. */
  get prereleasesVisible(): boolean {
    return this.prereleases;
  }

  /**
   * Shows or hides version suggestions.
   * @param visible - The new visibility.
   */
  setSuggestionsVisible(visible: boolean): void {
    if (this.suggestions === visible) {
      return;
    }
    this.suggestions = visible;
    this.changed();
  }

  /**
   * Shows or hides prerelease suggestions. Turning prereleases on implies
   * showing suggestions at all, since there'd otherwise be nowhere for them
   * to appear.
   * @param visible - The new visibility.
   */
  setPrereleasesVisible(visible: boolean): void {
    if (this.prereleases === visible) {
      return;
    }
    this.prereleases = visible;
    if (visible) {
      this.suggestions = true;
    }
    this.changed();
  }

  /** @inheritdoc */
  dispose(): void {
    this.changeEmitter.dispose();
  }

  /** Publishes the new state to context keys and listeners. */
  private changed(): void {
    this.syncContextKeys();
    this.changeEmitter.fire();
  }

  /** Mirrors the current toggles into VS Code's `when`-clause context. */
  private syncContextKeys(): void {
    void commands.executeCommand(
      "setContext",
      CONTEXT_KEYS.suggestions,
      this.suggestions,
    );
    void commands.executeCommand(
      "setContext",
      CONTEXT_KEYS.prereleases,
      this.prereleases,
    );
  }
}
