import * as assert from "assert";
import { buildHoverMarkdown } from "../../../src/features/hover-provider";
import type { DependencyStatus, RegistryMetadata } from "../../../src/types";

/**
 * Builds registry metadata with sensible defaults.
 * @param overrides - The fields to set.
 * @returns The metadata.
 */
function metadata(overrides: Partial<RegistryMetadata> = {}): RegistryMetadata {
  return {
    name: "lodash",
    latestVersion: "4.17.21",
    description: "Lodash modular utilities.",
    homepage: undefined,
    repositoryUrl: undefined,
    latestVersionPublishedAt: undefined,
    distTags: { latest: "4.17.21" },
    versions: ["4.17.20", "4.17.21"],
    publishedAt: {},
    peerDependenciesByVersion: {},
    deprecations: {},
    ...overrides,
  };
}

/**
 * Builds an analyzed dependency with sensible defaults, so each test only
 * states the part it cares about.
 * @param overrides - The fields to set.
 * @returns The status.
 */
function status(overrides: Partial<DependencyStatus> = {}): DependencyStatus {
  return {
    entry: {
      name: "lodash",
      specifier: "4.17.21",
      section: "dependencies",
      source: "npm",
      nameRange: { start: 0, end: 0 },
      specifierRange: { start: 0, end: 0 },
    },
    metadata: metadata(),
    resolvedSpecifier: "4.17.21",
    installedVersion: "4.17.21",
    latestVersion: "4.17.21",
    bump: "none",
    conflicts: [],
    vulnerabilities: [],
    deprecation: undefined,
    ...overrides,
  };
}

suite("hover-provider", () => {
  test("Builds hover markdown for an up-to-date package", () => {
    const hover = buildHoverMarkdown(status(), "1.2M");

    const markdown = hover.value;
    assert.ok(markdown.includes("**lodash**"));
    assert.ok(markdown.includes("up to date"));
    assert.ok(markdown.includes("4.17.21"));
    assert.ok(markdown.includes("1.2M downloads/mo"));
    assert.ok(markdown.includes("Lodash modular utilities."));
    assert.ok(hover.supportThemeIcons);
    assert.ok(hover.supportHtml);
  });

  test("Shows the version transition for an available update", () => {
    const hover = buildHoverMarkdown(
      status({
        entry: {
          name: "prisma",
          specifier: "^6.19.0",
          section: "dependencies",
          source: "npm",
          nameRange: { start: 0, end: 0 },
          specifierRange: { start: 0, end: 0 },
        },
        bump: "major",
        latestVersion: "7.9.1",
        metadata: metadata({ name: "prisma", latestVersion: "7.9.1" }),
      }),
    );

    assert.ok(hover.value.includes("major update"));
    assert.ok(hover.value.includes("^6.19.0"));
    assert.ok(hover.value.includes("7.9.1"));
  });

  test("Shows a distinct badge for specifiers that can't be compared", () => {
    const hover = buildHoverMarkdown(
      status({ bump: "unsupported", latestVersion: undefined }),
    );

    assert.ok(hover.value.includes("not comparable"));
  });

  test("Names each package blocking an upgrade and whether upgrading it helps", () => {
    const hover = buildHoverMarkdown(
      status({
        bump: "major",
        latestVersion: "8.1.0",
        conflicts: [
          {
            blockedBy: "some-plugin",
            blockerVersion: "2.1.0",
            requiredRange: "^7.0.0",
            resolvedByUpgradingBlocker: true,
          },
        ],
      }),
    );

    assert.ok(hover.value.includes("update blocked"));
    assert.ok(hover.value.includes("some-plugin@2.1.0"));
    assert.ok(hover.value.includes("^7.0.0"));
    assert.ok(hover.value.includes("upgrading"));
  });

  test("Reports each advisory with its fix version", () => {
    const hover = buildHoverMarkdown(
      status({
        vulnerabilities: [
          {
            id: "GHSA-1111-2222-3333",
            summary: "Prototype pollution",
            severity: "HIGH",
            url: "https://osv.dev/vulnerability/GHSA-1111-2222-3333",
            fixedVersion: "4.17.21",
          },
        ],
      }),
    );

    assert.ok(hover.value.includes("known vulnerability"));
    assert.ok(hover.value.includes("GHSA-1111-2222-3333"));
    assert.ok(hover.value.includes("Prototype pollution"));
    assert.ok(hover.value.includes("fixed in 4.17.21"));
  });

  test("Reports a publisher's deprecation notice", () => {
    const hover = buildHoverMarkdown(
      status({ deprecation: "This package is no longer maintained" }),
    );

    assert.ok(hover.value.includes("Deprecated"));
    assert.ok(hover.value.includes("no longer maintained"));
  });

  test("Escapes registry text before it reaches the HTML-enabled hover", () => {
    const hover = buildHoverMarkdown(
      status({ deprecation: "<img src=x onerror=alert(1)>" }),
    );

    assert.ok(!hover.value.includes("<img"));
    assert.ok(hover.value.includes("&lt;img"));
  });

  test("Links out to npm, the repository, and the homepage", () => {
    const hover = buildHoverMarkdown(
      status({
        metadata: metadata({
          repositoryUrl: "https://github.com/lodash/lodash",
          homepage: "https://lodash.com/",
        }),
      }),
    );

    assert.ok(hover.value.includes("https://www.npmjs.com/package/lodash"));
    assert.ok(hover.value.includes("https://github.com/lodash/lodash"));
    assert.ok(hover.value.includes("https://lodash.com/"));
  });

  test("Doesn't repeat a homepage that duplicates the repository link", () => {
    const url = "https://github.com/lodash/lodash";
    const hover = buildHoverMarkdown(
      status({ metadata: metadata({ repositoryUrl: url, homepage: url }) }),
    );

    assert.equal(hover.value.split(url).length - 1, 1);
  });

  test("Omits the npm link for a Node.js engine entry", () => {
    const hover = buildHoverMarkdown(
      status({
        entry: {
          name: "node",
          specifier: ">=22",
          section: "engines",
          source: "node",
          nameRange: { start: 0, end: 0 },
          specifierRange: { start: 0, end: 0 },
        },
      }),
    );

    assert.ok(!hover.value.includes("npmjs.com"));
  });
});
