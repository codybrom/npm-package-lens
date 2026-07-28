import * as assert from "assert";
import { contentFor } from "../../../src/features/dependency-decorations";

suite("dependency-decorations", () => {
  suite("contentFor", () => {
    test("Shows a checkmark when up to date", () => {
      assert.equal(contentFor("none", "1.2.3", undefined), "✓ up to date");
    });

    test("Shows the severity and target version for an update", () => {
      assert.equal(contentFor("major", "7.9.1", undefined), "⬆ 7.9.1 (major)");
      assert.equal(contentFor("minor", "1.3.0", undefined), "⬆ 1.3.0 (minor)");
      assert.equal(contentFor("patch", "1.2.4", undefined), "⬆ 1.2.4 (patch)");
    });

    test("Appends how long the update has been available, when known", () => {
      const fourDaysAgo = new Date(
        Date.now() - 4 * 24 * 60 * 60 * 1000,
      ).toISOString();

      assert.equal(
        contentFor("patch", "4.0.22", fourDaysAgo),
        "⬆ 4.0.22 (patch) — 4 days ago",
      );
    });

    test("Omits the publish time when unknown, even for an available update", () => {
      assert.equal(contentFor("major", "7.9.1", undefined), "⬆ 7.9.1 (major)");
    });
  });
});
