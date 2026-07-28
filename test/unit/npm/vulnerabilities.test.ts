import * as assert from "assert";
import { getVulnerabilities } from "../../../src/npm/vulnerabilities";

/** A request the stubbed `fetch` recorded. */
interface RecordedRequest {
  /** The requested URL. */
  url: string;
  /** The parsed request body, if there was one. */
  body: BatchRequest | undefined;
}

/** Stub handlers for the two OSV endpoints the client uses. */
interface OsvRoutes {
  /** Responds to a batch query, given the parsed request body. */
  querybatch?: (body: BatchRequest) => unknown;
  /** Responds to an advisory lookup, or returns `undefined` for a 404. */
  vulns?: (id: string) => unknown;
}

/** The body shape the client posts to the batch endpoint. */
interface BatchRequest {
  /** One entry per package version being checked. */
  queries: { version: string; package: { name: string; ecosystem: string } }[];
}

/**
 * Replaces global `fetch` with a router over the OSV endpoints, recording
 * every request so tests can assert on what was asked for.
 * @param routes - Handlers for each endpoint.
 * @returns The recorded requests and a restore function.
 */
function stubOsv(routes: OsvRoutes): {
  requests: RecordedRequest[];
  restore: () => void;
} {
  const original = globalThis.fetch;
  const requests: RecordedRequest[] = [];

  globalThis.fetch = ((input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const body: BatchRequest | undefined =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as BatchRequest)
        : undefined;
    requests.push({ url, body });

    if (url.endsWith("/querybatch")) {
      const result =
        body === undefined
          ? { results: [] }
          : (routes.querybatch?.(body) ?? { results: [] });
      return Promise.resolve(
        new Response(JSON.stringify(result), {
          headers: { "content-type": "application/json" },
        }),
      );
    }

    const id = url.slice(url.lastIndexOf("/") + 1);
    const advisory = routes.vulns?.(decodeURIComponent(id));
    return Promise.resolve(
      advisory === undefined
        ? new Response("not found", { status: 404 })
        : new Response(JSON.stringify(advisory), {
            headers: { "content-type": "application/json" },
          }),
    );
  }) as typeof fetch;

  return {
    requests,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** An advisory document shaped the way OSV returns them. */
const ADVISORY = {
  id: "GHSA-1111-2222-3333",
  summary: "Prototype pollution in lodash",
  database_specific: { severity: "HIGH" },
  affected: [
    {
      package: { name: "lodash", ecosystem: "npm" },
      ranges: [
        { type: "SEMVER", events: [{ introduced: "0" }, { fixed: "4.17.21" }] },
      ],
    },
  ],
};

suite("vulnerabilities", () => {
  test("Resolves advisories for an affected package", async () => {
    const { restore } = stubOsv({
      querybatch: () => ({ results: [{ vulns: [{ id: ADVISORY.id }] }] }),
      vulns: (id) => (id === ADVISORY.id ? ADVISORY : undefined),
    });

    try {
      const found = await getVulnerabilities([
        { name: "lodash", version: "4.17.20" },
      ]);

      assert.deepEqual(found.get("lodash@4.17.20"), [
        {
          id: ADVISORY.id,
          summary: "Prototype pollution in lodash",
          severity: "HIGH",
          url: `https://osv.dev/vulnerability/${ADVISORY.id}`,
          fixedVersion: "4.17.21",
        },
      ]);
    } finally {
      restore();
    }
  });

  test("Omits packages with no advisories", async () => {
    const { restore } = stubOsv({ querybatch: () => ({ results: [{}] }) });

    try {
      const found = await getVulnerabilities([
        { name: "lodash", version: "4.17.21" },
      ]);

      assert.equal(found.size, 0);
    } finally {
      restore();
    }
  });

  test("Queries each distinct package version once", async () => {
    const { requests, restore } = stubOsv({
      querybatch: (body) => ({
        results: (body as { queries: unknown[] }).queries.map(() => ({})),
      }),
    });

    try {
      await getVulnerabilities([
        { name: "lodash", version: "4.17.20" },
        { name: "lodash", version: "4.17.20" },
        { name: "semver", version: "7.0.0" },
      ]);

      assert.equal(requests.length, 1);
      assert.deepEqual(requests[0]?.body?.queries, [
        { version: "4.17.20", package: { name: "lodash", ecosystem: "npm" } },
        { version: "7.0.0", package: { name: "semver", ecosystem: "npm" } },
      ]);
    } finally {
      restore();
    }
  });

  test("Fetches each advisory's details only once across packages", async () => {
    const { requests, restore } = stubOsv({
      querybatch: () => ({
        results: [
          { vulns: [{ id: ADVISORY.id }] },
          { vulns: [{ id: ADVISORY.id }] },
        ],
      }),
      vulns: () => ADVISORY,
    });

    try {
      await getVulnerabilities([
        { name: "lodash", version: "4.17.20" },
        { name: "lodash", version: "4.17.19" },
      ]);

      const detailRequests = requests.filter((request) =>
        request.url.includes("/vulns/"),
      );
      assert.equal(detailRequests.length, 1);
    } finally {
      restore();
    }
  });

  test("Makes no request at all when there's nothing to check", async () => {
    const { requests, restore } = stubOsv({});

    try {
      assert.equal((await getVulnerabilities([])).size, 0);
      assert.equal(requests.length, 0);
    } finally {
      restore();
    }
  });

  test("Reports nothing when the advisory service is unreachable", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new Error("offline"));

    try {
      const found = await getVulnerabilities([
        { name: "lodash", version: "4.17.20" },
      ]);

      assert.equal(found.size, 0);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("Drops advisories whose details can't be resolved", async () => {
    const { restore } = stubOsv({
      querybatch: () => ({ results: [{ vulns: [{ id: "GHSA-missing" }] }] }),
      vulns: () => undefined,
    });

    try {
      const found = await getVulnerabilities([
        { name: "lodash", version: "4.17.20" },
      ]);

      assert.equal(found.size, 0);
    } finally {
      restore();
    }
  });
});
