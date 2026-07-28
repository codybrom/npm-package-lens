import * as assert from "assert";
import {
  applyVersionToSpecifier,
  getVersionSuggestions,
  type SuggestionContext,
} from "../../../src/npm/suggestions";

/**
 * Builds a suggestion context with sensible defaults, so each test only
 * states the part it cares about.
 * @param overrides - The fields to set.
 * @returns The context.
 */
function context(
  overrides: Partial<SuggestionContext> & { specifier: string },
): SuggestionContext {
  return {
    versions: ["1.0.0", "1.2.0", "2.0.0"],
    distTags: { latest: "2.0.0" },
    includePrereleases: false,
    prereleaseTagFilter: [],
    currentIsVulnerable: false,
    blockerCount: 0,
    updateSeverity: "major",
    includeUpToDate: true,
    ...overrides,
  };
}

suite("suggestions", () => {
  test("Reports a range that already admits the newest version", () => {
    const [current, ...rest] = getVersionSuggestions(
      context({ specifier: "^2.0.0" }),
    );

    assert.equal(current?.status, "satisfiesLatest");
    assert.equal(current?.version, "2.0.0");
    assert.deepEqual(rest, []);
  });

  test("Distinguishes an exact pin on the newest version from a range", () => {
    const [current] = getVersionSuggestions(context({ specifier: "2.0.0" }));

    assert.equal(current?.status, "latest");
    assert.equal(current?.label, "latest");
  });

  test("Keys an update's indicator to how far behind it is", () => {
    for (const severity of ["major", "minor", "patch"] as const) {
      const [, update] = getVersionSuggestions(
        context({ specifier: "^1.0.0", updateSeverity: severity }),
      );

      assert.equal(update?.status, severity);
    }
  });

  test("Labels an update with the version it moves to", () => {
    const [, update] = getVersionSuggestions(context({ specifier: "^1.0.0" }));

    assert.equal(update?.label, "Update to 2.0.0");
  });

  test("Names the version an outdated range resolves to, then offers the update", () => {
    const [current, update] = getVersionSuggestions(
      context({ specifier: "^1.0.0" }),
    );

    assert.equal(current?.status, "match");
    assert.equal(current?.label, "Resolved as 1.2.0");
    assert.equal(update?.status, "major");
    assert.equal(update?.version, "2.0.0");
    assert.equal(update?.replacement, "^2.0.0");
  });

  test("Keeps the author's range operator when offering an update", () => {
    const [, update] = getVersionSuggestions(context({ specifier: "~1.0.0" }));

    assert.equal(update?.replacement, "~2.0.0");
  });

  test("Marks an update away from a version with a known advisory", () => {
    const [, update] = getVersionSuggestions(
      context({ specifier: "^1.0.0", currentIsVulnerable: true }),
    );

    assert.equal(update?.status, "updatableVulnerable");
    assert.equal(
      update?.label,
      "Update to 2.0.0 — current version has an advisory",
    );
  });

  test("Reports a blocked update as blocked even when an advisory applies", () => {
    const [, update] = getVersionSuggestions(
      context({
        specifier: "^1.0.0",
        currentIsVulnerable: true,
        blockerCount: 1,
      }),
    );

    assert.equal(update?.status, "blocked");
    assert.equal(update?.label, "2.0.0 blocked by 1 dependency");
  });

  test("Marks an update a peer requirement blocks", () => {
    const [, update] = getVersionSuggestions(
      context({ specifier: "^1.0.0", blockerCount: 2 }),
    );

    assert.equal(update?.status, "blocked");
  });

  test("Lays a blocked dependency out as pin, take-anyway, and how many object", () => {
    const [resolved, blocked] = getVersionSuggestions(
      context({
        specifier: "^9.38.0",
        versions: ["9.38.0", "9.39.5", "10.8.0"],
        distTags: { latest: "10.8.0" },
        blockerCount: 2,
        updateSeverity: "major",
        includeUpToDate: false,
      }),
    );

    // Pinning to what's already installed is the safe action here, so it has
    // to be clickable rather than a label.
    assert.equal(resolved?.kind, "state");
    assert.equal(resolved?.label, "Resolved as 9.39.5");
    assert.equal(resolved?.replacement, "^9.39.5");

    assert.equal(blocked?.kind, "update");
    assert.equal(blocked?.status, "blocked");
    assert.equal(blocked?.label, "10.8.0 blocked by 2 dependencies");
    assert.equal(blocked?.replacement, "^10.8.0");
  });

  test("Counts a single blocker in the singular", () => {
    const [, blocked] = getVersionSuggestions(
      context({ specifier: "^1.0.0", blockerCount: 1 }),
    );

    assert.equal(blocked?.label, "2.0.0 blocked by 1 dependency");
  });

  test("Leaves the resolved state unclickable when it already says what's declared", () => {
    const [resolved] = getVersionSuggestions(
      context({
        specifier: "^1.2.0",
        versions: ["1.2.0", "2.0.0"],
        distTags: { latest: "2.0.0" },
      }),
    );

    assert.equal(resolved?.label, "Resolved as 1.2.0");
    assert.equal(resolved?.replacement, undefined);
  });

  test("Separates describing a state from offering an update", () => {
    const suggestions = getVersionSuggestions(context({ specifier: "^1.0.0" }));

    assert.deepEqual(
      suggestions.map((suggestion) => suggestion.kind),
      ["state", "update"],
    );
  });

  test("Says nothing about a dependency already on the newest version", () => {
    assert.deepEqual(
      getVersionSuggestions(
        context({ specifier: "^2.0.0", includeUpToDate: false }),
      ),
      [],
    );
    assert.deepEqual(
      getVersionSuggestions(
        context({ specifier: "2.0.0", includeUpToDate: false }),
      ),
      [],
    );
  });

  test("Still describes an up-to-date range when asked to", () => {
    const suggestions = getVersionSuggestions(
      context({ specifier: "^2.0.0", includeUpToDate: true }),
    );

    assert.equal(suggestions[0]?.status, "satisfiesLatest");
  });

  test("Keeps describing rows that need attention, even when hiding current ones", () => {
    const outdated = getVersionSuggestions(
      context({ specifier: "^1.0.0", includeUpToDate: false }),
    );
    assert.equal(outdated[0]?.status, "match");
    assert.equal(outdated[1]?.status, "major");

    const unmatched = getVersionSuggestions(
      context({ specifier: "^9.0.0", includeUpToDate: false }),
    );
    assert.equal(unmatched[0]?.status, "noMatch");
  });

  test("Keeps an up-to-date row that has a prerelease on offer", () => {
    const suggestions = getVersionSuggestions(
      context({
        specifier: "^2.0.0",
        versions: ["2.0.0", "3.0.0-beta.1"],
        includePrereleases: true,
        includeUpToDate: false,
      }),
    );

    assert.equal(suggestions.length, 2);
    assert.equal(suggestions[1]?.status, "prerelease");
  });

  test("Ignores prereleases when resolving what a stable range installs", () => {
    // A package publishing canary builds ahead of its latest release: npm
    // installs 2.0.1 for "^2.0.1", so the row is current and says nothing.
    assert.deepEqual(
      getVersionSuggestions(
        context({
          specifier: "^2.0.1",
          versions: ["2.0.1", "2.2.0-canary"],
          distTags: { latest: "2.0.1" },
          includeUpToDate: false,
        }),
      ),
      [],
    );
  });

  test("Resolves a prerelease range against prereleases of that version", () => {
    const [current] = getVersionSuggestions(
      context({
        specifier: "^2.0.0-beta.1",
        versions: ["1.0.0", "2.0.0-beta.1", "2.0.0-beta.3"],
        distTags: { latest: "1.0.0" },
      }),
    );

    assert.equal(current?.version, "2.0.0-beta.3");
  });

  test("Reports a range that matches nothing published", () => {
    const [current] = getVersionSuggestions(context({ specifier: "^9.0.0" }));

    assert.equal(current?.status, "noMatch");
  });

  test("Resolves a dist-tag specifier to the version it points at", () => {
    const suggestions = getVersionSuggestions(
      context({
        specifier: "beta",
        distTags: { latest: "2.0.0", beta: "3.0.0-beta.1" },
      }),
    );

    assert.equal(suggestions.length, 1);
    assert.equal(suggestions[0]?.version, "3.0.0-beta.1");
    assert.equal(suggestions[0]?.replacement, undefined);
  });

  test("Reports a local specifier as a directory rather than a version", () => {
    const suggestions = getVersionSuggestions(
      context({ specifier: "file:../shared" }),
    );

    assert.equal(suggestions.length, 1);
    assert.equal(suggestions[0]?.status, "directory");
    assert.equal(suggestions[0]?.replacement, undefined);
  });

  test("Offers nothing for a specifier that isn't a range at all", () => {
    assert.deepEqual(
      getVersionSuggestions(context({ specifier: "github:user/repo" })),
      [],
    );
  });

  test("Hides prereleases unless they're switched on", () => {
    const withoutPrereleases = getVersionSuggestions(
      context({
        specifier: "^2.0.0",
        versions: ["2.0.0", "3.0.0-beta.1"],
      }),
    );

    assert.equal(withoutPrereleases.length, 1);
    assert.equal(withoutPrereleases[0]?.status, "satisfiesLatest");

    const withPrereleases = getVersionSuggestions(
      context({
        specifier: "^2.0.0",
        versions: ["2.0.0", "3.0.0-beta.1"],
        includePrereleases: true,
      }),
    );

    assert.equal(withPrereleases[1]?.status, "prerelease");
    assert.equal(withPrereleases[1]?.version, "3.0.0-beta.1");
  });

  test("Names the dist-tag a prerelease is published under", () => {
    const suggestions = getVersionSuggestions(
      context({
        specifier: "^2.0.0",
        versions: ["2.0.0", "3.0.0-beta.1"],
        distTags: { latest: "2.0.0", next: "3.0.0-beta.1" },
        includePrereleases: true,
      }),
    );

    assert.equal(suggestions[1]?.label, "Update to 3.0.0-beta.1 (next)");
  });

  test("Honors the prerelease tag filter", () => {
    const suggestions = getVersionSuggestions(
      context({
        specifier: "^2.0.0",
        versions: ["2.0.0", "3.0.0-alpha.1"],
        includePrereleases: true,
        prereleaseTagFilter: ["beta"],
      }),
    );

    assert.equal(suggestions.length, 1);
  });

  test("Prefers the registry's latest dist-tag over the highest version", () => {
    const [current, update] = getVersionSuggestions(
      context({
        specifier: "^1.0.0",
        versions: ["1.0.0", "1.2.0", "2.0.0"],
        distTags: { latest: "1.2.0" },
      }),
    );

    assert.equal(current?.status, "major");
    assert.equal(current?.version, "1.2.0");
    assert.equal(update, undefined);
  });

  test("Offers an update the declared range already permits", () => {
    // "^9.12.0" installs 9.12.1 today, so nothing would change on disk — but
    // the number written in the manifest is still behind, which is what the
    // inline annotation reports. The action has to be available to match.
    const suggestions = getVersionSuggestions(
      context({
        specifier: "^9.12.0",
        versions: ["9.12.0", "9.12.1"],
        distTags: { latest: "9.12.1" },
        updateSeverity: "patch",
        includeUpToDate: false,
      }),
    );

    // No "satisfies latest" badge beside it: one glyph saying nothing to do
    // next to another offering an update reads as a contradiction.
    assert.equal(suggestions.length, 1);
    assert.equal(suggestions[0]?.status, "patch");
    assert.equal(suggestions[0]?.replacement, "^9.12.1");
    assert.equal(suggestions[0]?.satisfiedByRange, true);
  });

  test("Marks an update the range does not already cover", () => {
    const [, update] = getVersionSuggestions(context({ specifier: "^1.0.0" }));

    assert.equal(update?.satisfiedByRange, false);
  });

  test("Still says nothing when the declared version is the newest one", () => {
    assert.deepEqual(
      getVersionSuggestions(
        context({
          specifier: "^9.12.1",
          versions: ["9.12.0", "9.12.1"],
          distTags: { latest: "9.12.1" },
          includeUpToDate: false,
        }),
      ),
      [],
    );
  });

  test("Reports an error when nothing stable is published", () => {
    const [only] = getVersionSuggestions(
      context({ specifier: "^1.0.0", versions: [], distTags: {} }),
    );

    assert.equal(only?.status, "error");
  });

  suite("applyVersionToSpecifier", () => {
    test("Keeps the range operator", () => {
      assert.equal(applyVersionToSpecifier("^1.2.3", "2.0.0"), "^2.0.0");
      assert.equal(applyVersionToSpecifier("~1.2.3", "2.0.0"), "~2.0.0");
      assert.equal(applyVersionToSpecifier(">=1.2.3", "2.0.0"), ">=2.0.0");
    });

    test("Pins exactly when the specifier had no operator", () => {
      assert.equal(applyVersionToSpecifier("1.2.3", "2.0.0"), "2.0.0");
    });

    test("Leaves wildcards and compound ranges alone", () => {
      assert.equal(applyVersionToSpecifier("*", "2.0.0"), "*");
      assert.equal(applyVersionToSpecifier(">=1 <2", "2.0.0"), ">=1 <2");
      assert.equal(applyVersionToSpecifier("^1 || ^2", "3.0.0"), "^1 || ^2");
    });
  });
});
