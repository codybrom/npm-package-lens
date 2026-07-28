import * as assert from "assert";
import {
  getDownloadCount,
  getRegistryMetadata,
} from "../../../src/npm/registry-client";

type FetchStub = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Replaces global `fetch` for the duration of one test.
 * @param impl - The stub implementation to install.
 * @returns A restore function; call it after the test to put the real `fetch` back.
 */
function stubFetch(impl: FetchStub): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/**
 * Builds a JSON {@link Response} for use as a fetch stub's return value.
 * @param body - The value to serialize as the response body.
 * @param status - The HTTP status code to respond with.
 * @returns A `Response` with `content-type: application/json`.
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

suite("registry-client", () => {
  suite("getRegistryMetadata", () => {
    test("Returns parsed metadata for a valid response", async () => {
      const restore = stubFetch(() =>
        Promise.resolve(
          jsonResponse({
            name: "lodash",
            version: "4.17.20",
            description: "Lodash modular utilities.",
            homepage: "https://lodash.com/",
            repository: {
              type: "git",
              url: "git+https://github.com/lodash/lodash.git",
            },
            "dist-tags": { latest: "4.17.21" },
            time: { "4.17.21": "2026-04-01T21:01:20.458Z" },
          }),
        ),
      );

      try {
        const metadata = await getRegistryMetadata("lodash");
        assert.deepEqual(metadata, {
          name: "lodash",
          latestVersion: "4.17.21",
          description: "Lodash modular utilities.",
          homepage: "https://lodash.com/",
          repositoryUrl: "https://github.com/lodash/lodash",
          latestVersionPublishedAt: "2026-04-01T21:01:20.458Z",
          distTags: { latest: "4.17.21" },
        });
      } finally {
        restore();
      }
    });

    test("Leaves the published timestamp undefined when the time field lacks that version", async () => {
      const restore = stubFetch(() =>
        Promise.resolve(
          jsonResponse({
            name: "foo",
            "dist-tags": { latest: "2.0.0" },
            time: { "1.0.0": "2026-01-01T00:00:00.000Z" },
          }),
        ),
      );

      try {
        const metadata = await getRegistryMetadata("foo");
        assert.equal(metadata?.latestVersionPublishedAt, undefined);
      } finally {
        restore();
      }
    });

    test("Accepts a bare-string repository field", async () => {
      const restore = stubFetch(() =>
        Promise.resolve(
          jsonResponse({
            name: "old-style",
            repository: "https://github.com/foo/old-style",
          }),
        ),
      );

      try {
        const metadata = await getRegistryMetadata("old-style");
        assert.equal(
          metadata?.repositoryUrl,
          "https://github.com/foo/old-style",
        );
      } finally {
        restore();
      }
    });

    test("Rewrites a git:// repository URL to https://", async () => {
      const restore = stubFetch(() =>
        Promise.resolve(
          jsonResponse({
            name: "legacy",
            repository: { url: "git://github.com/foo/legacy.git" },
          }),
        ),
      );

      try {
        const metadata = await getRegistryMetadata("legacy");
        assert.equal(metadata?.repositoryUrl, "https://github.com/foo/legacy");
      } finally {
        restore();
      }
    });

    test("Leaves an unparsable repository URL undefined", async () => {
      const restore = stubFetch(() =>
        Promise.resolve(
          jsonResponse({
            name: "monorepo-path",
            repository: { url: "path:packages/monorepo-path" },
          }),
        ),
      );

      try {
        const metadata = await getRegistryMetadata("monorepo-path");
        assert.equal(metadata?.repositoryUrl, undefined);
      } finally {
        restore();
      }
    });

    test("Falls back to top-level version when dist-tags.latest is missing", async () => {
      const restore = stubFetch(() =>
        Promise.resolve(jsonResponse({ name: "foo", version: "1.0.0" })),
      );

      try {
        const metadata = await getRegistryMetadata("foo");
        assert.equal(metadata?.latestVersion, "1.0.0");
      } finally {
        restore();
      }
    });

    test("Returns undefined on a non-ok response", async () => {
      const restore = stubFetch(() => Promise.resolve(jsonResponse({}, 404)));

      try {
        const metadata = await getRegistryMetadata("does-not-exist");
        assert.equal(metadata, undefined);
      } finally {
        restore();
      }
    });

    test("Returns undefined when the response fails schema validation", async () => {
      const restore = stubFetch(() =>
        Promise.resolve(jsonResponse({ "dist-tags": "not-an-object" })),
      );

      try {
        const metadata = await getRegistryMetadata("malformed");
        assert.equal(metadata, undefined);
      } finally {
        restore();
      }
    });
  });

  suite("getDownloadCount", () => {
    test("Formats counts in the millions", async () => {
      const restore = stubFetch(() =>
        Promise.resolve(jsonResponse({ downloads: 1_234_567 })),
      );

      try {
        assert.equal(await getDownloadCount("popular-package"), "1.2M");
      } finally {
        restore();
      }
    });

    test("Formats counts in the thousands", async () => {
      const restore = stubFetch(() =>
        Promise.resolve(jsonResponse({ downloads: 4_300 })),
      );

      try {
        assert.equal(await getDownloadCount("mid-package"), "4.3k");
      } finally {
        restore();
      }
    });

    test("Formats counts below one thousand exactly", async () => {
      const restore = stubFetch(() =>
        Promise.resolve(jsonResponse({ downloads: 42 })),
      );

      try {
        assert.equal(await getDownloadCount("tiny-package"), "42");
      } finally {
        restore();
      }
    });

    test("Returns undefined on a non-ok response", async () => {
      const restore = stubFetch(() => Promise.resolve(jsonResponse({}, 500)));

      try {
        assert.equal(await getDownloadCount("broken"), undefined);
      } finally {
        restore();
      }
    });
  });
});
