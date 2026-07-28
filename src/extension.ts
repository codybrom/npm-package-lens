import { ExtensionContext, languages } from "vscode";
import { registerDependencyDecorations } from "./features/dependency-decorations";
import { NpmHoverProvider } from "./features/hover-provider";

/**
 * Extension entry point, invoked by VS Code when the extension activates
 * (see `activationEvents` in `package.json`). Registers the hover provider
 * and the inline dependency-status decorations feature.
 * @param context - The extension context provided by VS Code, used to
 * scope disposables to the extension's lifetime.
 */
export function activate(context: ExtensionContext): void {
  context.subscriptions.push(
    languages.registerHoverProvider(["json", "jsonc"], new NpmHoverProvider()),
  );

  registerDependencyDecorations(context);
}

/**
 * Extension deactivation hook, required by the VS Code extension API.
 * No-op: all cleanup is handled via disposables pushed onto
 * `context.subscriptions` during {@link activate}.
 */
export function deactivate(): void {
  // Intentionally empty.
}
