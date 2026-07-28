import * as path from "path";
import Mocha from "mocha";
import { glob } from "glob";

/**
 * Mocha entry point invoked by the VS Code test runner
 * (`--extensionTestsPath`). Discovers and runs every compiled `*.test.js`
 * file under `out/test/suite`, recursively.
 *
 * Scoped to `suite/` (not `test/` broadly) so it doesn't re-run the
 * plain-Node unit tests under `out/test/unit` — those run separately via
 * `npm run test:unit` and don't need an Extension Host.
 * @returns Resolves when all tests pass; rejects with a summary error if any fail.
 */
export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: "tdd", color: true });
  const testsRoot = __dirname;

  const files = await glob("**/**.test.js", { cwd: testsRoot });
  files.forEach((file) => mocha.addFile(path.resolve(testsRoot, file)));

  return new Promise((resolve, reject) => {
    mocha.run((failures: number) => {
      if (failures > 0) {
        reject(new Error(`${failures.toString()} tests failed.`));
      } else {
        resolve();
      }
    });
  });
}
