import * as assert from "assert";
import {
  parseManifest,
  type DependencyEntry,
  type OffsetRange,
} from "../../../src/parse/package-document";

/** The property paths the extension parses by default. */
const DEFAULT_PROPERTIES = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "overrides",
  "overrides.*",
  "pnpm.overrides",
];

/**
 * Reads back the text a parsed span covers, so tests assert on the spans
 * rather than trusting the offsets by inspection.
 * @param text - The manifest the entry was parsed from.
 * @param span - The span to read.
 * @returns The covered text.
 */
function slice(text: string, span: OffsetRange): string {
  return text.slice(span.start, span.end);
}

/**
 * Finds one entry by name.
 * @param entries - The parsed entries.
 * @param name - The package name to find.
 * @returns The matching entry.
 */
function byName(entries: DependencyEntry[], name: string): DependencyEntry {
  const entry = entries.find((candidate) => candidate.name === name);
  assert.ok(entry, `expected an entry named ${name}`);
  return entry;
}

suite("package-document", () => {
  test("Parses entries from every configured section", () => {
    const text = JSON.stringify(
      {
        dependencies: { lodash: "^4.17.21" },
        devDependencies: { typescript: "~6.0.3" },
        peerDependencies: { react: ">=18" },
        optionalDependencies: { fsevents: "2.3.3" },
        scripts: { build: "tsc" },
      },
      null,
      2,
    );

    const { entries } = parseManifest(text, DEFAULT_PROPERTIES);

    assert.deepEqual(
      entries.map((entry) => [entry.name, entry.specifier, entry.section]),
      [
        ["lodash", "^4.17.21", "dependencies"],
        ["typescript", "~6.0.3", "devDependencies"],
        ["react", ">=18", "peerDependencies"],
        ["fsevents", "2.3.3", "optionalDependencies"],
      ],
    );
  });

  test("Ignores sections that aren't configured", () => {
    const text = JSON.stringify({ resolutions: { lodash: "^4" } }, null, 2);

    const { entries } = parseManifest(text, DEFAULT_PROPERTIES);

    assert.deepEqual(entries, []);
  });

  test("Spans cover the name and specifier without their quotes", () => {
    const text = `{\n  "dependencies": {\n    "lodash": "^4.17.21"\n  }\n}`;

    const { entries } = parseManifest(text, DEFAULT_PROPERTIES);
    const entry = byName(entries, "lodash");

    assert.equal(slice(text, entry.nameRange), "lodash");
    assert.equal(slice(text, entry.specifierRange), "^4.17.21");
  });

  test("Reports each parsed section once, with its full span", () => {
    const text = `{\n  "dependencies": {\n    "lodash": "^4"\n  }\n}`;

    const { sections } = parseManifest(text, DEFAULT_PROPERTIES);

    assert.equal(sections.length, 1);
    const section = sections[0];
    assert.ok(section);
    assert.equal(section.path, "dependencies");
    assert.equal(slice(text, section.nameRange), "dependencies");
    assert.ok(slice(text, section.fullRange).startsWith('"dependencies"'));
    assert.ok(slice(text, section.fullRange).endsWith("}"));
  });

  test("Parses nested overrides, using the parent name for a '.' key", () => {
    const text = JSON.stringify(
      {
        overrides: {
          semver: "^7.8.5",
          "some-pkg": { ".": "^2.0.0", nanoid: "^5.0.0" },
        },
      },
      null,
      2,
    );

    const { entries } = parseManifest(text, DEFAULT_PROPERTIES);

    assert.deepEqual(
      entries.map((entry) => [entry.name, entry.specifier, entry.section]),
      [
        ["semver", "^7.8.5", "overrides"],
        ["some-pkg", "^2.0.0", "overrides.some-pkg"],
        ["nanoid", "^5.0.0", "overrides.some-pkg"],
      ],
    );
  });

  test("Parses nested paths like pnpm.overrides", () => {
    const text = JSON.stringify(
      { pnpm: { overrides: { semver: "^7" } } },
      null,
      2,
    );

    const { entries } = parseManifest(text, DEFAULT_PROPERTIES);

    assert.deepEqual(
      entries.map((entry) => [entry.name, entry.section]),
      [["semver", "pnpm.overrides"]],
    );
  });

  test("Resolves engines.node against the Node.js release index", () => {
    const text = JSON.stringify(
      { engines: { node: ">=22", npm: ">=10", vscode: "^1.0.0" } },
      null,
      2,
    );

    const { entries } = parseManifest(text, DEFAULT_PROPERTIES);

    assert.deepEqual(
      entries.map((entry) => [entry.name, entry.specifier, entry.source]),
      [
        ["node", ">=22", "node"],
        ["npm", ">=10", "npm"],
      ],
    );
  });

  test("Spans only the version part of packageManager", () => {
    const text = `{\n  "packageManager": "pnpm@10.4.1+sha512.abc"\n}`;

    const { entries } = parseManifest(text, DEFAULT_PROPERTIES);
    const entry = byName(entries, "pnpm");

    assert.equal(entry.specifier, "10.4.1");
    assert.equal(entry.section, "packageManager");
    assert.equal(slice(text, entry.specifierRange), "10.4.1");
  });

  test("Ignores a packageManager naming an unknown tool", () => {
    const text = `{ "packageManager": "cargo@1.0.0" }`;

    assert.deepEqual(parseManifest(text, DEFAULT_PROPERTIES).entries, []);
  });

  test("Returns what parsed from a manifest that is mid-edit", () => {
    const text = `{\n  "dependencies": {\n    "lodash": "^4.17.21",\n    "semver":\n  }\n}`;

    const { entries } = parseManifest(text, DEFAULT_PROPERTIES);

    assert.deepEqual(
      entries.map((entry) => entry.name),
      ["lodash"],
    );
  });

  test("Returns nothing for a document that isn't a JSON object", () => {
    assert.deepEqual(parseManifest("[]", DEFAULT_PROPERTIES).entries, []);
    assert.deepEqual(parseManifest("", DEFAULT_PROPERTIES).entries, []);
  });

  test("Skips non-string entries such as a nested object under a flat section", () => {
    const text = JSON.stringify(
      { dependencies: { lodash: "^4", bad: { nested: "^1" } } },
      null,
      2,
    );

    const { entries } = parseManifest(text, ["dependencies"]);

    assert.deepEqual(
      entries.map((entry) => entry.name),
      ["lodash"],
    );
  });
});
