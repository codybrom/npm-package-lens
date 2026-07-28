import * as assert from "assert";
import { getLatestNodeLts } from "../../../src/npm/nodejs-releases";

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

suite("nodejs-releases", () => {
  suite("getLatestNodeLts", () => {
    test("Returns the newest LTS release, skipping newer Current releases", async () => {
      const restore = stubFetch(() =>
        Promise.resolve(
          jsonResponse([
            { version: "v27.0.0", date: "2026-07-01", lts: false },
            { version: "v24.18.0", date: "2026-07-08", lts: "Krypton" },
            { version: "v24.17.0", date: "2026-06-01", lts: "Krypton" },
            { version: "v20.20.0", date: "2026-05-01", lts: "Iron" },
          ]),
        ),
      );

      try {
        const latest = await getLatestNodeLts();
        assert.deepEqual(latest, {
          version: "24.18.0",
          publishedAt: "2026-07-08",
        });
      } finally {
        restore();
      }
    });

    test("Returns undefined when no LTS release exists in the index", async () => {
      const restore = stubFetch(() =>
        Promise.resolve(
          jsonResponse([
            { version: "v27.0.0", date: "2026-07-01", lts: false },
          ]),
        ),
      );

      try {
        assert.equal(await getLatestNodeLts(), undefined);
      } finally {
        restore();
      }
    });

    test("Returns undefined on a non-ok response", async () => {
      const restore = stubFetch(() => Promise.resolve(jsonResponse([], 500)));

      try {
        assert.equal(await getLatestNodeLts(), undefined);
      } finally {
        restore();
      }
    });

    test("Returns undefined when the response fails schema validation", async () => {
      const restore = stubFetch(() =>
        Promise.resolve(jsonResponse({ not: "an array" })),
      );

      try {
        assert.equal(await getLatestNodeLts(), undefined);
      } finally {
        restore();
      }
    });
  });
});
