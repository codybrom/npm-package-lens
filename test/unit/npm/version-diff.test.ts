import * as assert from "assert";
import {
  classifySpecifier,
  getBumpSeverity,
  resolveInstalledVersion,
} from "../../../src/npm/version-diff";

suite("version-diff", () => {
  suite("getBumpSeverity", () => {
    test("Detects no update when versions match", () => {
      assert.equal(getBumpSeverity("^1.2.3", "1.2.3"), "none");
    });

    test("Detects a major update", () => {
      assert.equal(getBumpSeverity("^6.19.0", "7.9.1"), "major");
    });

    test("Detects a minor update", () => {
      assert.equal(getBumpSeverity("^1.2.3", "1.3.0"), "minor");
    });

    test("Detects a patch update", () => {
      assert.equal(getBumpSeverity("^1.2.3", "1.2.4"), "patch");
    });

    test("Treats any change under major version zero as major", () => {
      assert.equal(getBumpSeverity("^0.4.0", "0.4.1"), "major");
    });

    test("Returns unsupported when the installed version is missing", () => {
      assert.equal(getBumpSeverity(undefined, "1.0.0"), "unsupported");
    });

    test("Returns none when the latest version is missing", () => {
      assert.equal(getBumpSeverity("1.0.0", undefined), "none");
    });
  });

  suite("classifySpecifier", () => {
    test("Classifies a semver range", () => {
      assert.deepEqual(classifySpecifier("^1.2.3"), {
        kind: "range",
        range: "^1.2.3",
      });
    });

    test("Classifies a bare version as a range", () => {
      assert.deepEqual(classifySpecifier("1.2.3"), {
        kind: "range",
        range: "1.2.3",
      });
    });

    test("Classifies a dist-tag", () => {
      assert.deepEqual(classifySpecifier("latest"), {
        kind: "tag",
        tag: "latest",
      });
      assert.deepEqual(classifySpecifier("beta"), {
        kind: "tag",
        tag: "beta",
      });
    });

    test("Classifies an npm alias, recursively classifying the inner specifier", () => {
      assert.deepEqual(classifySpecifier("npm:foo@^1.2.3"), {
        kind: "alias",
        packageName: "foo",
        inner: { kind: "range", range: "^1.2.3" },
      });
    });

    test("Classifies an npm alias to a scoped package", () => {
      assert.deepEqual(
        classifySpecifier("npm:@typescript/typescript6@^6.0.2"),
        {
          kind: "alias",
          packageName: "@typescript/typescript6",
          inner: { kind: "range", range: "^6.0.2" },
        },
      );
    });

    test("Classifies an npm alias to a tag", () => {
      assert.deepEqual(classifySpecifier("npm:foo@beta"), {
        kind: "alias",
        packageName: "foo",
        inner: { kind: "tag", tag: "beta" },
      });
    });

    test("Classifies workspace: specifiers as unsupported", () => {
      assert.deepEqual(classifySpecifier("workspace:*"), {
        kind: "unsupported",
      });
      assert.deepEqual(classifySpecifier("workspace:^1.0.0"), {
        kind: "unsupported",
      });
    });

    test("Classifies git URLs as unsupported", () => {
      assert.deepEqual(
        classifySpecifier("git+https://github.com/foo/bar.git"),
        { kind: "unsupported" },
      );
      assert.deepEqual(classifySpecifier("git://github.com/foo/bar.git"), {
        kind: "unsupported",
      });
    });

    test("Classifies GitHub shorthand as unsupported", () => {
      assert.deepEqual(classifySpecifier("github:npm/cli#HEAD"), {
        kind: "unsupported",
      });
      assert.deepEqual(classifySpecifier("npm/cli#c12ea07"), {
        kind: "unsupported",
      });
    });

    test("Classifies local paths and file:/link: protocols as unsupported", () => {
      assert.deepEqual(classifySpecifier("./my-package"), {
        kind: "unsupported",
      });
      assert.deepEqual(classifySpecifier("../my-package"), {
        kind: "unsupported",
      });
      assert.deepEqual(classifySpecifier("file:../foo"), {
        kind: "unsupported",
      });
      assert.deepEqual(classifySpecifier("link:../foo"), {
        kind: "unsupported",
      });
    });

    test("Classifies remote tarball URLs as unsupported", () => {
      assert.deepEqual(
        classifySpecifier(
          "https://registry.npmjs.org/semver/-/semver-1.0.0.tgz",
        ),
        { kind: "unsupported" },
      );
    });
  });

  suite("resolveInstalledVersion", () => {
    test("Passes a range through unchanged", () => {
      assert.equal(
        resolveInstalledVersion(classifySpecifier("^1.2.3"), {}),
        "^1.2.3",
      );
    });

    test("Resolves a tag via distTags", () => {
      assert.equal(
        resolveInstalledVersion(classifySpecifier("beta"), {
          latest: "2.0.0",
          beta: "2.1.0-beta.1",
        }),
        "2.1.0-beta.1",
      );
    });

    test("Returns undefined for a tag with no matching distTags entry", () => {
      assert.equal(
        resolveInstalledVersion(classifySpecifier("beta"), {
          latest: "2.0.0",
        }),
        undefined,
      );
    });

    test("Resolves the inner specifier of an alias", () => {
      assert.equal(
        resolveInstalledVersion(classifySpecifier("npm:foo@^1.2.3"), {}),
        "^1.2.3",
      );
    });

    test("Returns undefined for unsupported specifiers", () => {
      assert.equal(
        resolveInstalledVersion(classifySpecifier("workspace:*"), {}),
        undefined,
      );
    });
  });

  suite(
    "getBumpSeverity + classifySpecifier + resolveInstalledVersion (integration)",
    () => {
      function bumpFor(
        installed: string,
        latest: string,
        distTags: Record<string, string> = {},
      ) {
        return getBumpSeverity(
          resolveInstalledVersion(classifySpecifier(installed), distTags),
          latest,
        );
      }

      test("Resolves npm alias specifiers before diffing", () => {
        assert.equal(
          bumpFor("npm:@typescript/typescript6@^6.0.2", "7.0.2"),
          "major",
        );
      });

      test("Resolves a dist-tag specifier before diffing", () => {
        assert.equal(
          bumpFor("beta", "7.0.2", { beta: "6.0.2", latest: "7.0.2" }),
          "major",
        );
      });

      test("Reports unsupported for workspace: and git specifiers, not none", () => {
        assert.equal(bumpFor("workspace:*", "1.0.0"), "unsupported");
        assert.equal(
          bumpFor("git+https://github.com/foo/bar.git", "1.0.0"),
          "unsupported",
        );
      });
    },
  );
});
