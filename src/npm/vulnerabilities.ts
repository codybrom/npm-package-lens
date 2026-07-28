import type { CancellationToken } from "vscode";
import { z } from "zod";
import { Vulnerability } from "../types";

/** The OSV.dev API, which aggregates advisories across ecosystems. */
const OSV_API_URL = "https://api.osv.dev/v1";

/** Advisories are looked up in batches of this size, per OSV's documented limit. */
const MAX_QUERIES_PER_BATCH = 100;

/** How many advisory detail requests run concurrently. */
const MAX_CONCURRENT_DETAIL_REQUESTS = 8;

const batchResponseSchema = z.object({
  results: z.array(
    z.object({
      vulns: z.array(z.object({ id: z.string() })).optional(),
    }),
  ),
});

const advisorySchema = z.object({
  id: z.string(),
  summary: z.string().optional(),
  database_specific: z.object({ severity: z.string().optional() }).optional(),
  affected: z
    .array(
      z.object({
        package: z.object({ name: z.string().optional() }).optional(),
        ranges: z
          .array(
            z.object({
              type: z.string().optional(),
              events: z
                .array(z.object({ fixed: z.string().optional() }))
                .optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});

/** One package version to check for advisories. */
export interface VulnerabilityQuery {
  /** The package name. */
  name: string;
  /** The exact version in use. */
  version: string;
}

/**
 * Looks up known advisories for a set of package versions.
 *
 * Queries are sent to OSV's batch endpoint, which returns advisory IDs only;
 * the details behind each distinct ID are then fetched once and reused
 * across every package affected by it. Advisories are immutable once
 * published, so callers can cache the details indefinitely.
 *
 * Resolves to an empty map rather than throwing on any failure — a
 * vulnerability check that can't reach the network should degrade to
 * "nothing known", not break the annotations around it.
 * @param queries - The package versions to check; duplicates are collapsed.
 * @param token - Optional cancellation token; in-flight requests are aborted when triggered.
 * @returns Advisories keyed by `"name@version"`, omitting entries with none.
 */
export async function getVulnerabilities(
  queries: VulnerabilityQuery[],
  token?: CancellationToken,
): Promise<Map<string, Vulnerability[]>> {
  const unique = [...new Map(queries.map((q) => [cacheKey(q), q])).values()];
  const found = new Map<string, Vulnerability[]>();
  if (unique.length === 0) {
    return found;
  }

  const signal = token ? toAbortSignal(token) : null;
  const idsByPackage = new Map<string, string[]>();

  for (
    let offset = 0;
    offset < unique.length;
    offset += MAX_QUERIES_PER_BATCH
  ) {
    const batch = unique.slice(offset, offset + MAX_QUERIES_PER_BATCH);
    const results = await queryBatch(batch, signal);
    batch.forEach((query, index) => {
      const ids = results[index];
      if (ids && ids.length > 0) {
        idsByPackage.set(cacheKey(query), ids);
      }
    });
  }

  const advisories = await fetchAdvisories(
    new Set([...idsByPackage.values()].flat()),
    signal,
  );

  for (const [key, ids] of idsByPackage) {
    const packageName = key.slice(0, key.lastIndexOf("@"));
    const resolved = ids
      .map((id) => advisories.get(id))
      .filter((advisory): advisory is Advisory => advisory !== undefined)
      .map((advisory) => toVulnerability(advisory, packageName));
    if (resolved.length > 0) {
      found.set(key, resolved);
    }
  }

  return found;
}

/**
 * Builds the key a package version's advisories are stored under.
 * @param query - The package version.
 * @returns The `"name@version"` key.
 */
export function cacheKey(query: VulnerabilityQuery): string {
  return `${query.name}@${query.version}`;
}

/**
 * Sends one batch of queries to OSV, returning advisory IDs positionally.
 * @param batch - Up to {@link MAX_QUERIES_PER_BATCH} package versions.
 * @param signal - Abort signal for the request.
 * @returns Advisory IDs per query, aligned with `batch`; all empty on failure.
 */
async function queryBatch(
  batch: VulnerabilityQuery[],
  signal: AbortSignal | null,
): Promise<string[][]> {
  const empty = batch.map(() => []);

  try {
    const response = await fetch(`${OSV_API_URL}/querybatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal,
      body: JSON.stringify({
        queries: batch.map((query) => ({
          version: query.version,
          package: { name: query.name, ecosystem: "npm" },
        })),
      }),
    });
    if (!response.ok) {
      return empty;
    }

    const parsed = batchResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      return empty;
    }

    return batch.map(
      (_, index) =>
        parsed.data.results[index]?.vulns?.map((vuln) => vuln.id) ?? [],
    );
  } catch {
    return empty;
  }
}

/** A validated OSV advisory document. */
type Advisory = z.infer<typeof advisorySchema>;

/**
 * Fetches the full document for each advisory ID.
 * @param ids - The distinct advisory IDs to resolve.
 * @param signal - Abort signal for the requests.
 * @returns The advisories that resolved successfully, keyed by ID.
 */
async function fetchAdvisories(
  ids: Set<string>,
  signal: AbortSignal | null,
): Promise<Map<string, Advisory>> {
  const advisories = new Map<string, Advisory>();
  const pending = [...ids];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const id = pending[nextIndex++];
      if (id === undefined) {
        return;
      }

      const advisory = await fetchAdvisory(id, signal);
      if (advisory) {
        advisories.set(id, advisory);
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(MAX_CONCURRENT_DETAIL_REQUESTS, pending.length) },
      worker,
    ),
  );

  return advisories;
}

/**
 * Fetches one advisory document.
 * @param id - The advisory ID, e.g. `"GHSA-1234-5678-90ab"`.
 * @param signal - Abort signal for the request.
 * @returns The advisory, or `undefined` if it couldn't be fetched or validated.
 */
async function fetchAdvisory(
  id: string,
  signal: AbortSignal | null,
): Promise<Advisory | undefined> {
  try {
    const response = await fetch(
      `${OSV_API_URL}/vulns/${encodeURIComponent(id)}`,
      { signal },
    );
    if (!response.ok) {
      return undefined;
    }

    const parsed = advisorySchema.safeParse(await response.json());
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Projects an advisory down to the fields the UI shows, picking the fix
 * version from the entry describing the package in question.
 * @param advisory - The advisory document.
 * @param packageName - The package the advisory was matched against.
 * @returns The display-ready vulnerability.
 */
function toVulnerability(
  advisory: Advisory,
  packageName: string,
): Vulnerability {
  const affected = advisory.affected?.find(
    (entry) => entry.package?.name === packageName,
  );

  const fixedVersion = affected?.ranges
    ?.flatMap((range) => range.events ?? [])
    .map((event) => event.fixed)
    .find((version): version is string => version !== undefined);

  return {
    id: advisory.id,
    summary: advisory.summary,
    severity: advisory.database_specific?.severity,
    url: `https://osv.dev/vulnerability/${encodeURIComponent(advisory.id)}`,
    fixedVersion,
  };
}

/**
 * Bridges a VS Code {@link CancellationToken} to a standard {@link AbortSignal}
 * so it can be passed directly to `fetch`.
 * @param token - The cancellation token to bridge.
 * @returns A signal that aborts when `token` is cancelled.
 */
function toAbortSignal(token: CancellationToken): AbortSignal {
  const controller = new AbortController();
  token.onCancellationRequested(() => {
    controller.abort();
  });
  return controller.signal;
}
