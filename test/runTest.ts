import * as path from "path";
import { runTests } from "@vscode/test-electron";

/**
 * Downloads (or reuses a cached) VS Code, launches it in extension
 * development mode with the compiled extension loaded, and runs the Mocha
 * suite via {@link ../suite/index.run | suite/index.ts's `run`}.
 *
 * Invoked directly via `npm test`; not part of the extension's runtime.
 */
async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, "../../");
  const extensionTestsPath = path.resolve(__dirname, "./suite/index");

  try {
    await runTests({ extensionDevelopmentPath, extensionTestsPath });
  } catch (err) {
    console.error("Failed to run tests:", err);
    process.exit(1);
  }
}

void main();
