import * as assert from "assert";
import { packageNameForLine } from "../../../src/features/hover-provider";

suite("packageNameForLine", () => {
  test("Extracts the package name from a dependency line", () => {
    assert.equal(packageNameForLine('    "lodash": "^4.17.21",'), "lodash");
  });

  test("Extracts the package name when the line has no trailing comma", () => {
    assert.equal(packageNameForLine('  "lodash": "^4.17.21"'), "lodash");
  });

  test("Resolves scoped package names", () => {
    assert.equal(
      packageNameForLine('    "@types/node": "^26.1.2",'),
      "@types/node",
    );
  });

  test("Returns undefined for reserved top-level keys", () => {
    assert.equal(packageNameForLine('  "name": "my-package",'), undefined);
    assert.equal(packageNameForLine('  "version": "1.0.0",'), undefined);
    assert.equal(packageNameForLine('  "dependencies": {'), undefined);
  });

  test("Returns undefined for lines that aren't dependency entries", () => {
    assert.equal(packageNameForLine("{"), undefined);
    assert.equal(packageNameForLine("}"), undefined);
    assert.equal(packageNameForLine('  "scripts": {'), undefined);
  });
});
