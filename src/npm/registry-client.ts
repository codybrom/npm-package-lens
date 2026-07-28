import type { CancellationToken } from "vscode";
import { z } from "zod";
import { RegistryMetadata } from "../types";

/** The public npm registry, used when no other registry is configured. */
export const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org";

/** The npm downloads API, which is not part of the registry and never overridden. */
const DOWNLOADS_API_URL = "https://api.npmjs.org/downloads/point/last-month";

const versionManifestSchema = z.object({
  peerDependencies: z.record(z.string(), z.string()).optional(),
  peerDependenciesMeta: z
    .record(z.string(), z.object({ optional: z.boolean().optional() }))
    .optional(),
  deprecated: z.string().optional(),
});

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
  versions: z.record(z.string(), versionManifestSchema).optional(),
});

const npmDownloadsSchema = z.object({
  downloads: z.number().optional(),
});

/** Options shared by every registry request. */
export interface RegistryRequestOptions {
  /** Base URL of the registry to query; defaults to {@link DEFAULT_REGISTRY_URL}. */
  registryUrl?: string | undefined;
  /** Cancellation token; the in-flight request is aborted when triggered. */
  token?: CancellationToken | undefined;
}

/**
 * Fetches a package's full registry document — metadata, every published
 * version, and each version's peer dependencies.
 *
 * The full document is requested rather than npm's abbreviated
 * (`application/vnd.npm.install-v1+json`) form because the abbreviated form
 * omits `time`, `description`, and `repository`, which the hover and inline
 * annotations need. One request per package therefore serves every feature,
 * and callers are expected to cache the result.
 *
 * Resolves to `undefined` rather than throwing on any failure — a 4xx/5xx
 * response, a network error, a response that doesn't match the expected
 * shape, or cancellation via `token`. Callers that need to distinguish
 * these cases should inspect `token.isCancellationRequested` themselves.
 * @param packageName - The npm package name to look up, e.g. `"lodash"`.
 * @param options - Registry URL and cancellation options.
 * @returns The package's registry metadata, or `undefined` if it couldn't be fetched or validated.
 */
export async function getRegistryMetadata(
  packageName: string,
  options: RegistryRequestOptions = {},
): Promise<RegistryMetadata | undefined> {
  const registryUrl = options.registryUrl ?? DEFAULT_REGISTRY_URL;
  const response = await fetch(
    `${registryUrl}/${encodePackageName(packageName)}`,
    { signal: options.token ? toAbortSignal(options.token) : null },
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
  const versionManifests = payload.versions ?? {};

  const peerDependenciesByVersion: Record<string, Record<string, string>> = {};
  const deprecations: Record<string, string> = {};
  for (const [version, manifest] of Object.entries(versionManifests)) {
    const peers = requiredPeerDependencies(manifest);
    if (peers) {
      peerDependenciesByVersion[version] = peers;
    }
    if (manifest.deprecated !== undefined) {
      deprecations[version] = manifest.deprecated;
    }
  }

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
    versions: Object.keys(versionManifests),
    publishedAt: payload.time ?? {},
    peerDependenciesByVersion,
    deprecations,
  };
}

/**
 * Fetches a package's download count for the trailing 30 days from the npm
 * downloads API, formatted for display (e.g. `"1.2M"`, `"430k"`).
 *
 * Always queries the public npm API regardless of the configured registry,
 * since download statistics are an npmjs.com service rather than part of the
 * registry protocol. Resolves to `undefined` on any failure, mirroring
 * {@link getRegistryMetadata}.
 * @param packageName - The npm package name to look up.
 * @param token - Optional cancellation token; the in-flight request is aborted when triggered.
 * @returns A formatted download count, or `undefined` if it couldn't be fetched.
 */
export async function getDownloadCount(
  packageName: string,
  token?: CancellationToken,
): Promise<string | undefined> {
  const response = await fetch(
    `${DOWNLOADS_API_URL}/${encodePackageName(packageName)}`,
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
 * Selects the peer dependencies a package genuinely requires, dropping any
 * marked optional in `peerDependenciesMeta` — npm won't fail an install over
 * those, so neither should the conflict analysis.
 * @param manifest - One version's manifest from the registry document.
 * @returns The required peer dependency ranges, or `undefined` if there are none.
 */
function requiredPeerDependencies(
  manifest: z.infer<typeof versionManifestSchema>,
): Record<string, string> | undefined {
  const declared = manifest.peerDependencies;
  if (!declared) {
    return undefined;
  }

  const required = Object.fromEntries(
    Object.entries(declared).filter(
      ([name]) => manifest.peerDependenciesMeta?.[name]?.optional !== true,
    ),
  );

  return Object.keys(required).length > 0 ? required : undefined;
}

/**
 * Percent-encodes a package name for use in a registry URL path, leaving the
 * `/` that separates a scope from its name intact — `@scope/name` is a single
 * path segment to the registry, and encoding its slash yields a 404.
 * @param packageName - The package name, possibly scoped.
 * @returns The encoded name.
 */
function encodePackageName(packageName: string): string {
  return packageName
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
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
