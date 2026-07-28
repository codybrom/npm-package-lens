import type { CancellationToken } from "vscode";
import { z } from "zod";
import { RegistryMetadata } from "../types";

const npmRegistryPackageSchema = z.object({
  name: z.string().optional(),
  version: z.string().optional(),
  description: z.string().optional(),
  homepage: z.string().optional(),
  repository: z
    .union([z.string(), z.object({ url: z.string().optional() })])
    .optional(),
  "dist-tags": z.record(z.string(), z.string()).optional(),
  time: z.record(z.string(), z.string()).optional(),
});

const npmDownloadsSchema = z.object({
  downloads: z.number().optional(),
});

/**
 * Fetches package metadata (name, latest version, description) from the
 * public npm registry.
 *
 * Resolves to `undefined` rather than throwing on any failure — a 4xx/5xx
 * response, a network error, a response that doesn't match the expected
 * shape, or cancellation via `token`. Callers that need to distinguish
 * these cases should inspect `token.isCancellationRequested` themselves.
 * @param packageName - The npm package name to look up, e.g. `"lodash"`.
 * @param token - Optional cancellation token; the in-flight request is aborted when triggered.
 * @returns The package's registry metadata, or `undefined` if it couldn't be fetched or validated.
 */
export async function getRegistryMetadata(
  packageName: string,
  token?: CancellationToken,
): Promise<RegistryMetadata | undefined> {
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(packageName)}`,
    { signal: token ? toAbortSignal(token) : null },
  );
  if (!response.ok) {
    return undefined;
  }

  const result = npmRegistryPackageSchema.safeParse(await response.json());
  if (!result.success) {
    return undefined;
  }

  const payload = result.data;
  const distTags = payload["dist-tags"] ?? {};
  const latestVersion = distTags.latest ?? payload.version;
  return {
    name: payload.name,
    latestVersion,
    description: payload.description,
    homepage: payload.homepage,
    repositoryUrl: normalizeRepositoryUrl(payload.repository),
    latestVersionPublishedAt: latestVersion
      ? payload.time?.[latestVersion]
      : undefined,
    distTags,
  };
}

/**
 * Fetches a package's download count for the trailing 30 days from the npm
 * downloads API, formatted for display (e.g. `"1.2M"`, `"430k"`).
 *
 * Resolves to `undefined` on any failure, mirroring {@link getRegistryMetadata}.
 * @param packageName - The npm package name to look up.
 * @param token - Optional cancellation token; the in-flight request is aborted when triggered.
 * @returns A formatted download count, or `undefined` if it couldn't be fetched.
 */
export async function getDownloadCount(
  packageName: string,
  token?: CancellationToken,
): Promise<string | undefined> {
  const response = await fetch(
    `https://api.npmjs.org/downloads/point/last-month/${encodeURIComponent(packageName)}`,
    { signal: token ? toAbortSignal(token) : null },
  );
  if (!response.ok) {
    return undefined;
  }

  const result = npmDownloadsSchema.safeParse(await response.json());
  return typeof result.data?.downloads === "number"
    ? formatDownloadCount(result.data.downloads)
    : undefined;
}

/**
 * Normalizes a `package.json` `repository` field into a plain `https://`
 * URL suitable for a clickable link.
 *
 * npm registry `repository` entries are commonly either a bare URL string
 * or `{ url }`, and the URL itself is often an SCP-style git remote
 * (`git+https://github.com/foo/bar.git`, `git://github.com/foo/bar.git`)
 * rather than a browsable web address.
 * @param repository - The raw `repository` field from the registry response.
 * @returns A `https://` URL, or `undefined` if `repository` is missing or unparsable.
 */
function normalizeRepositoryUrl(
  repository: string | { url?: string | undefined } | undefined,
): string | undefined {
  const raw = typeof repository === "string" ? repository : repository?.url;
  if (!raw) {
    return undefined;
  }

  const cleaned = raw
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/\.git$/, "");

  return /^https?:\/\//.test(cleaned) ? cleaned : undefined;
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

/**
 * Formats a raw download count into a compact, human-readable string.
 * @param downloads - A non-negative download count.
 * @returns `"1.2M"` for millions, `"430k"` for thousands, or the exact count below 1000.
 */
function formatDownloadCount(downloads: number): string {
  if (downloads >= 1_000_000) {
    return `${(downloads / 1_000_000).toFixed(1)}M`;
  }

  if (downloads >= 1_000) {
    return `${(downloads / 1_000).toFixed(1)}k`;
  }

  return downloads.toString();
}
