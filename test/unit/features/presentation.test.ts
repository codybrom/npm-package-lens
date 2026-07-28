import * as assert from "assert";
import {
  annotationFor,
  displayStateOf,
  summarize,
  summaryText,
} from "../../../src/features/presentation";
import type { DependencyStatus } from "../../../src/types";

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
      specifier: "^4.17.20",
      section: "dependencies",
      source: "npm",
      nameRange: { start: 0, end: 0 },
      specifierRange: { start: 0, end: 0 },
    },
    metadata: undefined,
    resolvedSpecifier: "^4.17.20",
    installedVersion: undefined,
    latestVersion: "4.17.21",
    bump: "patch",
    conflicts: [],
    vulnerabilities: [],
    deprecation: undefined,
    ...overrides,
  };
}

/** A representative advisory, for tests that only need one to exist. */
const ADVISORY = {
  id: "GHSA-1111-2222-3333",
  summary: "Prototype pollution",
  severity: "HIGH",
  url: "https://osv.dev/vulnerability/GHSA-1111-2222-3333",
  fixedVersion: "4.17.21",
};

/** A representative peer conflict, for tests that only need one to exist. */
const CONFLICT = {
  blockedBy: "some-plugin",
  blockerVersion: "1.0.0",
  requiredRange: "^3.0.0",
  resolvedByUpgradingBlocker: false,
};

suite("presentation", () => {
  suite("displayStateOf", () => {
    test("Ranks an advisory above the size of the update behind it", () => {
      assert.equal(
        displayStateOf(status({ bump: "patch", vulnerabilities: [ADVISORY] })),
        "vulnerable",
      );
    });

    test("Reports a blocked update rather than its severity", () => {
      assert.equal(
        displayStateOf(status({ bump: "major", conflicts: [CONFLICT] })),
        "blocked",
      );
    });

    test("Reports deprecation ahead of an available update", () => {
      assert.equal(
        displayStateOf(status({ bump: "minor", deprecation: "use foo" })),
        "deprecated",
      );
    });

    test("Falls back to the update severity", () => {
      assert.equal(displayStateOf(status({ bump: "minor" })), "minor");
      assert.equal(displayStateOf(status({ bump: "none" })), "upToDate");
    });

    test("Reports a specifier that can't be compared as unknown", () => {
      assert.equal(displayStateOf(status({ bump: "unsupported" })), "unknown");
      assert.equal(
        displayStateOf(status({ latestVersion: undefined })),
        "unknown",
      );
    });
  });

  suite("annotationFor", () => {
    test("Names the newer version and how far behind it is", () => {
      const text = annotationFor(status({ bump: "major" }), true);

      assert.ok(text?.includes("4.17.21"));
      assert.ok(text?.includes("major"));
    });

    test("Names the packages blocking an update", () => {
      const text = annotationFor(status({ conflicts: [CONFLICT] }), true);

      assert.ok(text?.includes("blocked by some-plugin"));
    });

    test("Collapses a long list of blockers", () => {
      const conflicts = ["a", "b", "c", "d"].map((name) => ({
        ...CONFLICT,
        blockedBy: name,
      }));

      const text = annotationFor(status({ conflicts }), true);

      assert.ok(text?.includes("a, b +2 more"));
    });

    test("Counts advisories", () => {
      assert.ok(
        annotationFor(status({ vulnerabilities: [ADVISORY] }), true)?.includes(
          "1 advisory",
        ),
      );
      assert.ok(
        annotationFor(
          status({ vulnerabilities: [ADVISORY, ADVISORY] }),
          true,
        )?.includes("2 advisories"),
      );
    });

    test("Respects the up-to-date display setting", () => {
      assert.equal(
        annotationFor(status({ bump: "none" }), true),
        "✓ up to date",
      );
      assert.equal(annotationFor(status({ bump: "none" }), false), undefined);
    });

    test("Annotates nothing when there's nothing to compare", () => {
      assert.equal(
        annotationFor(status({ bump: "unsupported" }), true),
        undefined,
      );
    });
  });

  suite("summarize", () => {
    test("Counts each dependency in exactly one action bucket", () => {
      const summary = summarize([
        status({ bump: "major" }),
        status({ bump: "patch" }),
        status({ bump: "major", conflicts: [CONFLICT] }),
        status({ bump: "none" }),
        status({ bump: "unsupported" }),
      ]);

      assert.deepEqual(summary, {
        updates: 2,
        blocked: 1,
        vulnerable: 0,
        upToDate: 1,
        comparable: 4,
      });
    });

    test("Counts advisories alongside the update bucket", () => {
      const summary = summarize([
        status({ bump: "patch", vulnerabilities: [ADVISORY] }),
      ]);

      assert.equal(summary.vulnerable, 1);
      assert.equal(summary.updates, 1);
    });
  });

  suite("summaryText", () => {
    test("Says everything is current when nothing needs doing", () => {
      const text = summaryText(summarize([status({ bump: "none" })]));

      assert.equal(text, "✓ All 1 packages up to date");
    });

    test("Lists each kind of outstanding work", () => {
      const text = summaryText(
        summarize([
          status({ bump: "major" }),
          status({ bump: "major", conflicts: [CONFLICT] }),
          status({ bump: "patch", vulnerabilities: [ADVISORY] }),
        ]),
      );

      assert.ok(text.includes("2 updates available"));
      assert.ok(text.includes("1 blocked"));
      assert.ok(text.includes("1 vulnerable"));
    });

    test("Says so when there's nothing comparable at all", () => {
      assert.equal(summaryText(summarize([])), "No comparable dependencies");
    });
  });
});
