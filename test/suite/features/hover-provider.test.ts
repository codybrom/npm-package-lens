import * as assert from "assert";
import { buildHoverMarkdown } from "../../../src/features/hover-provider";

suite("hover-provider", () => {
  test("Builds hover markdown for an up-to-date package", () => {
    const hover = buildHoverMarkdown({
      name: "lodash",
      installedVersion: "4.17.21",
      resolvedInstalledVersion: "4.17.21",
      latestVersion: "4.17.21",
      description: "Lodash modular utilities.",
      downloads: "1.2M",
    });

    const markdown = hover.value;
    assert.ok(markdown.includes("**lodash**"));
    assert.ok(markdown.includes("up to date"));
    assert.ok(markdown.includes("4.17.21"));
    assert.ok(markdown.includes("1.2M downloads/mo"));
    assert.ok(markdown.includes("Lodash modular utilities."));
    assert.ok(hover.supportThemeIcons);
    assert.ok(hover.supportHtml);
  });

  test("Builds hover markdown for a major update", () => {
    const hover = buildHoverMarkdown({
      name: "prisma",
      installedVersion: "^6.19.0",
      resolvedInstalledVersion: "^6.19.0",
      latestVersion: "7.9.1",
      description: "Database toolkit.",
    });

    const markdown = hover.value;
    assert.ok(markdown.includes("major update"));
    assert.ok(markdown.includes("^6.19.0"));
    assert.ok(markdown.includes("7.9.1"));
  });

  test("Shows a distinct badge for specifiers that can't be compared", () => {
    const hover = buildHoverMarkdown({
      name: "my-workspace-package",
      installedVersion: "workspace:*",
      latestVersion: "1.0.0",
    });

    assert.ok(hover.value.includes("not comparable"));
    assert.ok(!hover.value.includes("up to date"));
  });

  test("Truncates long descriptions", () => {
    const longDescription = "a".repeat(200);
    const hover = buildHoverMarkdown({
      name: "example",
      latestVersion: "1.0.0",
      description: longDescription,
    });

    assert.ok(hover.value.includes("…"));
    assert.ok(!hover.value.includes(longDescription));
  });

  test("Places the version line below the title, on its own line", () => {
    const hover = buildHoverMarkdown({
      name: "lodash",
      installedVersion: "4.17.21",
      resolvedInstalledVersion: "4.17.21",
      latestVersion: "4.17.21",
    });

    const [title, versionLine] = hover.value.split("\n\n");
    assert.equal(title, "**lodash**");
    assert.ok(versionLine?.includes("4.17.21"));
  });

  test("Shows the status badge after the version, not before", () => {
    const hover = buildHoverMarkdown({
      name: "prisma",
      installedVersion: "^6.19.0",
      resolvedInstalledVersion: "^6.19.0",
      latestVersion: "7.9.1",
    });

    const [, versionLine] = hover.value.split("\n\n");
    const versionIndex = versionLine?.indexOf("7.9.1") ?? -1;
    const badgeIndex = versionLine?.indexOf("major update") ?? -1;
    assert.ok(versionIndex >= 0 && badgeIndex >= 0);
    assert.ok(versionIndex < badgeIndex);
  });

  test("Shows how recently the latest version was published, inline on the version line", () => {
    const oneWeekAgo = new Date(
      Date.now() - 7 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const hover = buildHoverMarkdown({
      name: "lodash",
      latestVersion: "4.17.21",
      latestVersionPublishedAt: oneWeekAgo,
    });

    const [, versionLine] = hover.value.split("\n\n");
    assert.ok(versionLine?.includes("published 7 days ago"));
  });

  test("Omits the published text when the timestamp is unknown", () => {
    const hover = buildHoverMarkdown({
      name: "lodash",
      latestVersion: "4.17.21",
    });

    assert.ok(!hover.value.includes("published"));
  });

  test("Always links to the npm package page", () => {
    const hover = buildHoverMarkdown({
      name: "lodash",
      latestVersion: "4.17.21",
    });

    assert.ok(
      hover.value.includes(
        '<a href="https://www.npmjs.com/package/lodash">npm</a>',
      ),
    );
  });

  test("Links to the repository and homepage when both are known and distinct", () => {
    const hover = buildHoverMarkdown({
      name: "lodash",
      latestVersion: "4.17.21",
      repositoryUrl: "https://github.com/lodash/lodash",
      homepage: "https://lodash.com",
    });

    assert.ok(
      hover.value.includes(
        '<a href="https://github.com/lodash/lodash">Repository</a>',
      ),
    );
    assert.ok(hover.value.includes('<a href="https://lodash.com">Website</a>'));
  });

  test("Omits the homepage link when it duplicates the repository URL", () => {
    const hover = buildHoverMarkdown({
      name: "example",
      latestVersion: "1.0.0",
      repositoryUrl: "https://github.com/foo/bar",
      homepage: "https://github.com/foo/bar",
    });

    assert.ok(!hover.value.includes(">Website<"));
  });

  test("Shows the download count on the links row, after the other links", () => {
    const hover = buildHoverMarkdown({
      name: "lodash",
      latestVersion: "4.17.21",
      repositoryUrl: "https://github.com/lodash/lodash",
      downloads: "1.2M",
    });

    const linksLine = hover.value.split("\n\n").at(-1);
    const repoIndex = linksLine?.indexOf("Repository") ?? -1;
    const downloadsIndex = linksLine?.indexOf("1.2M downloads/mo") ?? -1;
    assert.ok(repoIndex >= 0 && downloadsIndex >= 0);
    assert.ok(repoIndex < downloadsIndex);
  });
});
