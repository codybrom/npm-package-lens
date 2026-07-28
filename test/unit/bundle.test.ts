import * as assert from "assert";
import Module from "node:module";
import { join } from "node:path";

/**
 * The bundle built by `npm run bundle` — the file VS Code actually loads.
 * Resolved from this compiled test's location (`out/test/unit`) up to the
 * repository root.
 */
const BUNDLE_PATH = join(__dirname, "..", "..", "..", "dist", "extension.js");

/**
 * The callable target every stubbed `vscode` export proxies, since a proxy
 * needs a function target to be callable or constructible.
 * @returns Nothing.
 */
function noop(): undefined {
  return undefined;
}

/**
 * Stands in for the `vscode` module, which only exists inside the extension
 * host. Every property resolves to something callable and constructible, so
 * module-level code that touches the API (creating emitters, reading enum
 * members) loads without incident.
 */
const vscodeStub: unknown = new Proxy(
  {},
  {
    get: () =>
      new Proxy(noop, {
        get: () => () => undefined,
        apply: () => undefined,
        construct: () => ({}),
      }),
  },
);

/**
 * Loads a module with `vscode` resolving to {@link vscodeStub}, restoring
 * normal resolution afterwards.
 * @param path - Absolute path of the module to load.
 * @returns The module's exports.
 */
function loadWithStubbedVscode(path: string): Record<string, unknown> {
  const loader = Module as unknown as {
    _load: (request: string, ...rest: unknown[]) => unknown;
  };
  const original = loader._load;

  loader._load = (request, ...rest) =>
    request === "vscode" ? vscodeStub : original.call(Module, request, ...rest);

  try {
    return Module.createRequire(__filename)(path) as Record<string, unknown>;
  } finally {
    loader._load = original;
  }
}

suite("bundle", () => {
  /*
   * Bundling can break in ways neither other tier sees: both run against
   * `out/`, where every dependency is still resolved from node_modules at
   * runtime. A dependency whose entry point hides its `require` calls inside
   * a factory function (a UMD wrapper, say) bundles without warnings and
   * then fails to activate, because the paths it requires don't exist next
   * to `dist/extension.js`. Loading the real bundle is the only thing that
   * catches it before a user does.
   */
  test("The bundled extension loads and exports its activation hooks", () => {
    const extension = loadWithStubbedVscode(BUNDLE_PATH);

    assert.equal(typeof extension.activate, "function");
    assert.equal(typeof extension.deactivate, "function");
  });
});
