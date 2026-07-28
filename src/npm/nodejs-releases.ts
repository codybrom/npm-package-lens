import type { CancellationToken } from "vscode";
import { z } from "zod";

const nodeReleaseSchema = z.object({
  version: z.string(),
  date: z.string(),
  lts: z.union([z.string(), z.literal(false)]),
});

const nodeReleaseIndexSchema = z.array(nodeReleaseSchema);

/** Metadata about the latest LTS Node.js release. */
export interface LatestNodeLts {
  /** The version, without a leading `v` (e.g. `"24.18.0"`), matching npm's `engines.node` convention. */
  version: string;
  /** ISO 8601 date the release was published. */
  publishedAt: string;
}

/**
 * Fetches the {@link https://nodejs.org/dist/index.json | Node.js release index}
 * and returns the newest LTS (Long-Term Support) release.
 *
 * Current (non-LTS) releases are intentionally excluded: most projects
 * target LTS in `engines.node`, so comparing against the latest Current
 * release would flag nearly every project as perpetually behind a version
 * most teams don't intentionally run in production.
 *
 * Resolves to `undefined` rather than throwing on any failure — a 4xx/5xx
 * response, a network error, a response that doesn't match the expected
 * shape, cancellation via `token`, or no LTS release found in the index.
 * @param token - Optional cancellation token; the in-flight request is aborted when triggered.
 * @returns The latest LTS release, or `undefined` if it couldn't be determined.
 */
export async function getLatestNodeLts(
  token?: CancellationToken,
): Promise<LatestNodeLts | undefined> {
  const response = await fetch("https://nodejs.org/dist/index.json", {
    signal: token ? toAbortSignal(token) : null,
  });
  if (!response.ok) {
    return undefined;
  }

  const result = nodeReleaseIndexSchema.safeParse(await response.json());
  if (!result.success) {
    return undefined;
  }

  const latestLts = result.data.find((release) => release.lts !== false);
  if (!latestLts) {
    return undefined;
  }

  return {
    version: latestLts.version.replace(/^v/, ""),
    publishedAt: latestLts.date,
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
