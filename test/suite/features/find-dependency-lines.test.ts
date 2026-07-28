import * as assert from "assert";
import { workspace } from "vscode";
import { findDependencyLines } from "../../../src/features/dependency-decorations";

suite("findDependencyLines", () => {
  test("Finds entries in dependencies and devDependencies", async () => {
    const document = await workspace.openTextDocument({
      language: "json",
      content: JSON.stringify(
        {
          dependencies: { lodash: "^4.17.21" },
          devDependencies: { typescript: "^5.9.3" },
        },
        null,
        2,
      ),
    });

    const matches = findDependencyLines(document);
    const byName = new Map(matches.map((m) => [m.packageName, m]));

    assert.equal(byName.get("lodash")?.installedVersion, "^4.17.21");
    assert.equal(byName.get("lodash")?.source, "npm");
    assert.equal(byName.get("typescript")?.installedVersion, "^5.9.3");
  });

  test("Finds entries in overrides and resolutions", async () => {
    const document = await workspace.openTextDocument({
      language: "json",
      content: JSON.stringify(
        {
          overrides: { esbuild: "0.28.1" },
          resolutions: { "@mui/utils": "9.1.1" },
        },
        null,
        2,
      ),
    });

    const matches = findDependencyLines(document);
    const byName = new Map(matches.map((m) => [m.packageName, m]));

    assert.equal(byName.get("esbuild")?.installedVersion, "0.28.1");
    assert.equal(byName.get("@mui/utils")?.installedVersion, "9.1.1");
  });

  test("Finds engines.node and tags it with the node source", async () => {
    const document = await workspace.openTextDocument({
      language: "json",
      content: JSON.stringify({ engines: { node: "24.x" } }, null, 2),
    });

    const matches = findDependencyLines(document);
    const nodeMatch = matches.find((m) => m.source === "node");

    assert.equal(nodeMatch?.packageName, "node");
    assert.equal(nodeMatch?.installedVersion, "24.x");
  });

  test("Ignores other engines entries (e.g. npm) inside engines", async () => {
    const document = await workspace.openTextDocument({
      language: "json",
      content: JSON.stringify(
        { engines: { node: "24.x", npm: ">=10" } },
        null,
        2,
      ),
    });

    const matches = findDependencyLines(document);
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.packageName, "node");
  });

  test("Finds packageManager and captures the tool name and version", async () => {
    const document = await workspace.openTextDocument({
      language: "json",
      content: JSON.stringify({ packageManager: "npm@12.0.1" }, null, 2),
    });

    const matches = findDependencyLines(document);
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.packageName, "npm");
    assert.equal(matches[0]?.installedVersion, "12.0.1");
    assert.equal(matches[0]?.source, "npm");
  });

  test("Ignores unrelated sections like scripts", async () => {
    const document = await workspace.openTextDocument({
      language: "json",
      content: JSON.stringify(
        {
          scripts: { build: "tsc -p ./" },
          dependencies: { lodash: "^4.17.21" },
        },
        null,
        2,
      ),
    });

    const matches = findDependencyLines(document);
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.packageName, "lodash");
  });
});
