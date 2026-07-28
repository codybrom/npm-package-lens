import { dirname } from "node:path";
import semver from "semver";
import {
  Disposable,
  EventEmitter,
  type Event,
  type TextDocument,
  type Uri,
} from "vscode";
import { getSettings, type Settings } from "../config";
import { getLatestNodeLts } from "../npm/nodejs-releases";
import {
  readInstalledPackages,
  type InstalledPackage,
} from "../npm/installed-packages";
import { findPeerConflicts, type PeerSource } from "../npm/peer-conflicts";
import { getRegistryMetadata } from "../npm/registry-client";
import {
  classifySpecifier,
  getBumpSeverity,
  resolveInstalledVersion,
} from "../npm/version-diff";
import {
  cacheKey,
  getVulnerabilities,
  type VulnerabilityQuery,
} from "../npm/vulnerabilities";
import { parseManifest, type ManifestSection } from "../parse/package-document";
import type {
  DependencyStatus,
  PeerConflict,
  RegistryMetadata,
  Vulnerability,
} from "../types";

/** The analyzed state of one manifest, as consumed by every UI feature. */
export interface ManifestAnalysis {
  /** The manifest this describes. */
  uri: Uri;
  /** The document version analyzed, so stale results can be discarded. */
  documentVersion: number;
  /** Every declared dependency, in document order. */
  statuses: DependencyStatus[];
  /** Every dependency section, in document order. */
  sections: ManifestSection[];
}

/** How many registry lookups run concurrently per analysis pass. */
const MAX_CONCURRENT_LOOKUPS = 8;

/** The pseudo-package name used to cache the Node.js release lookup. */
const NODE_CACHE_KEY = "node:";

/** A package name paired with the registry that resolves its versions. */
interface PackageRef {
  /** The package name. */
  name: string;
  /** Which registry resolves it. */
  source: "npm" | "node";
}

/** A cached registry lookup, with the time it stops being trusted. */
interface CacheEntry {
  /** The metadata fetched, or `undefined` if the lookup failed. */
  metadata: RegistryMetadata | undefined;
  /** Epoch milliseconds after which the entry is re-fetched. */
  expiresAt: number;
}

/**
 * Parses manifests, resolves every declared dependency against the registry,
 * and layers peer-conflict and vulnerability analysis on top — once, so that
 * the decorations, hover, CodeLens, status bar, and panel all render from
 * the same picture rather than each fetching their own.
 *
 * Results are cached per manifest and invalidated on demand; registry
 * responses are cached separately, across manifests, for the configured
 * duration.
 */
export class DependencyAnalyzer implements Disposable {
  private readonly changeEmitter = new EventEmitter<Uri>();
  private readonly analyses = new Map<string, ManifestAnalysis>();
  private readonly inFlight = new Map<string, Promise<ManifestAnalysis>>();
  private readonly registryCache = new Map<string, CacheEntry>();
  private readonly advisoryCache = new Map<string, Vulnerability[]>();

  /** Fires with a manifest's URI whenever its analysis is replaced. */
  readonly onDidChangeAnalysis: Event<Uri> = this.changeEmitter.event;

  /**
   * Returns the most recent analysis of a manifest, without triggering one.
   * @param uri - The manifest to look up.
   * @returns The analysis, or `undefined` if the manifest hasn't been analyzed yet.
   */
  get(uri: Uri): ManifestAnalysis | undefined {
    return this.analyses.get(uri.toString());
  }

  /** @returns Every analysis computed so far, in insertion order. */
  all(): ManifestAnalysis[] {
    return [...this.analyses.values()];
  }

  /**
   * Analyzes a manifest, reusing an in-flight pass for the same document
   * rather than starting a second one.
   * @param document - The manifest to analyze.
   * @param force - Whether to discard cached registry data first.
   * @returns The completed analysis.
   */
  async analyze(
    document: TextDocument,
    force = false,
  ): Promise<ManifestAnalysis> {
    const key = document.uri.toString();

    if (force) {
      this.clearCache();
    }

    const existing = this.inFlight.get(key);
    if (existing) {
      return existing;
    }

    const pass = this.runAnalysis(document).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, pass);
    return pass;
  }

  /**
   * Drops every cached registry response and advisory, so the next analysis
   * re-fetches from the network.
   */
  clearCache(): void {
    this.registryCache.clear();
    this.advisoryCache.clear();
  }

  /**
   * Forgets a manifest's analysis, e.g. once its document is closed.
   * @param uri - The manifest to forget.
   */
  forget(uri: Uri): void {
    this.analyses.delete(uri.toString());
  }

  /** @inheritdoc */
  dispose(): void {
    this.changeEmitter.dispose();
  }

  /**
   * Runs one full analysis pass: parse, resolve against the registry, then
   * layer on peer-conflict and vulnerability analysis.
   * @param document - The manifest to analyze.
   * @returns The completed analysis.
   */
  private async runAnalysis(document: TextDocument): Promise<ManifestAnalysis> {
    const settings = getSettings(document.uri);
    const documentVersion = document.version;
    const parsed = parseManifest(
      document.getText(),
      settings.dependencyProperties,
    );

    const metadataByName = await this.fetchAllMetadata(
      parsed.entries,
      settings,
    );

    const resolved = parsed.entries.map((entry) => {
      const metadata = metadataByName.get(
        metadataKey(entry.source, entry.name),
      );
      const resolvedSpecifier =
        entry.source === "node"
          ? entry.specifier
          : resolveInstalledVersion(
              classifySpecifier(entry.specifier),
              metadata?.distTags ?? {},
            );

      return { entry, metadata, resolvedSpecifier };
    });

    const installed = settings.checkPeerConflicts
      ? await readInstalledPackages(dirname(document.uri.fsPath))
      : new Map<string, InstalledPackage>();

    const inUseVersions = new Map(
      resolved.map(({ entry, resolvedSpecifier }) => [
        entry.name,
        installed.get(entry.name)?.version ??
          lowestVersionIn(resolvedSpecifier),
      ]),
    );

    const peerSources = settings.checkPeerConflicts
      ? buildPeerSources(installed, resolved, inUseVersions)
      : [];

    const advisories = settings.checkVulnerabilities
      ? await this.fetchVulnerabilities(resolved, inUseVersions)
      : new Map<string, Vulnerability[]>();

    const statuses: DependencyStatus[] = resolved.map(
      ({ entry, metadata, resolvedSpecifier }) => {
        const latestVersion = metadata?.latestVersion;
        const installedVersion = inUseVersions.get(entry.name);

        return {
          entry,
          metadata,
          resolvedSpecifier,
          installedVersion: installed.get(entry.name)?.version,
          latestVersion,
          bump: getBumpSeverity(resolvedSpecifier, latestVersion),
          conflicts: conflictsFor(entry.name, latestVersion, peerSources),
          vulnerabilities: installedVersion
            ? (advisories.get(`${entry.name}@${installedVersion}`) ?? [])
            : [],
          deprecation: installedVersion
            ? metadata?.deprecations[installedVersion]
            : undefined,
        };
      },
    );

    const analysis: ManifestAnalysis = {
      uri: document.uri,
      documentVersion,
      statuses,
      sections: parsed.sections,
    };

    this.analyses.set(document.uri.toString(), analysis);
    this.changeEmitter.fire(document.uri);
    return analysis;
  }

  /**
   * Resolves registry metadata for every distinct package named in the
   * manifest, bounded by {@link MAX_CONCURRENT_LOOKUPS} concurrent requests.
   * @param entries - The parsed dependency entries.
   * @param settings - The settings governing the registry and cache.
   * @returns Metadata keyed by source and package name.
   */
  private async fetchAllMetadata(
    entries: PackageRef[],
    settings: Settings,
  ): Promise<Map<string, RegistryMetadata | undefined>> {
    const keys = [
      ...new Map(
        entries.map((entry) => [metadataKey(entry.source, entry.name), entry]),
      ),
    ];

    const results = new Map<string, RegistryMetadata | undefined>();
    let nextIndex = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        const next = keys[nextIndex++];
        if (next === undefined) {
          return;
        }
        const [key, entry] = next;
        results.set(key, await this.getMetadata(entry, settings));
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(MAX_CONCURRENT_LOOKUPS, keys.length) },
        worker,
      ),
    );

    return results;
  }

  /**
   * Resolves one package's metadata, serving from cache when the entry is
   * still fresh.
   * @param entry - The package to resolve.
   * @param settings - The settings governing the registry and cache.
   * @returns The metadata, or `undefined` if the lookup failed.
   */
  private async getMetadata(
    entry: PackageRef,
    settings: Settings,
  ): Promise<RegistryMetadata | undefined> {
    const key = `${settings.registryUrl}|${metadataKey(entry.source, entry.name)}`;
    const cached = this.registryCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.metadata;
    }

    const metadata =
      entry.source === "node"
        ? await fetchNodeMetadata()
        : await getRegistryMetadata(entry.name, {
            registryUrl: settings.registryUrl,
          }).catch(() => undefined);

    this.registryCache.set(key, {
      metadata,
      expiresAt: Date.now() + settings.cacheDurationMinutes * 60_000,
    });
    return metadata;
  }

  /**
   * Looks up advisories for the version of each package actually in use,
   * reusing previously-resolved advisories so repeated passes only query
   * versions this session hasn't seen.
   * @param resolved - The entries with their metadata attached.
   * @param inUseVersions - The concrete version in use per package name.
   * @returns Advisories keyed by `"name@version"`.
   */
  private async fetchVulnerabilities(
    resolved: { entry: PackageRef }[],
    inUseVersions: Map<string, string | undefined>,
  ): Promise<Map<string, Vulnerability[]>> {
    const queries: VulnerabilityQuery[] = [];
    const known = new Map<string, Vulnerability[]>();

    for (const { entry } of resolved) {
      const version = inUseVersions.get(entry.name);
      if (entry.source === "node" || version === undefined) {
        continue;
      }

      const query = { name: entry.name, version };
      const cached = this.advisoryCache.get(cacheKey(query));
      if (cached) {
        if (cached.length > 0) {
          known.set(cacheKey(query), cached);
        }
        continue;
      }
      queries.push(query);
    }

    const fetched = await getVulnerabilities(queries).catch(
      () => new Map<string, Vulnerability[]>(),
    );

    for (const query of queries) {
      this.advisoryCache.set(
        cacheKey(query),
        fetched.get(cacheKey(query)) ?? [],
      );
    }

    return new Map([...known, ...fetched]);
  }
}

/**
 * Builds the key registry metadata is cached and looked up under. The source
 * is part of the key so a Node.js lookup can't collide with an npm package
 * that happens to be called `node`.
 * @param source - Which registry resolves the name.
 * @param name - The package name.
 * @returns The composite key.
 */
function metadataKey(source: "npm" | "node", name: string): string {
  return source === "node" ? NODE_CACHE_KEY : `npm:${name}`;
}

/**
 * Fetches the newest Node.js LTS release, shaped as registry metadata so the
 * `engines.node` entry flows through the same code path as npm packages.
 * @returns Metadata describing the newest LTS release, or `undefined` if it couldn't be fetched.
 */
async function fetchNodeMetadata(): Promise<RegistryMetadata | undefined> {
  const latest = await getLatestNodeLts().catch(() => undefined);
  if (!latest) {
    return undefined;
  }

  return {
    name: "node",
    latestVersion: latest.version,
    description: "Node.js JavaScript runtime (latest LTS release)",
    homepage: "https://nodejs.org",
    repositoryUrl: "https://github.com/nodejs/node",
    latestVersionPublishedAt: latest.publishedAt,
    distTags: { latest: latest.version },
    versions: [latest.version],
    publishedAt: { [latest.version]: latest.publishedAt },
    peerDependenciesByVersion: {},
    deprecations: {},
  };
}

/**
 * Assembles every package whose peer requirements could object to an
 * upgrade: what's installed in `node_modules`, plus any declared dependency
 * that isn't installed, whose requirements are read from the registry
 * instead.
 * @param installed - Packages read from `node_modules`.
 * @param resolved - The declared entries with their registry metadata.
 * @param inUseVersions - The concrete version in use per package name.
 * @returns The peer sources to check upgrades against.
 */
function buildPeerSources(
  installed: Map<string, InstalledPackage>,
  resolved: { entry: PackageRef; metadata: RegistryMetadata | undefined }[],
  inUseVersions: Map<string, string | undefined>,
): PeerSource[] {
  const sources = new Map<string, PeerSource>();

  for (const { entry, metadata } of resolved) {
    if (entry.source === "node") {
      continue;
    }

    const version = inUseVersions.get(entry.name);
    const latestPeers = metadata?.latestVersion
      ? (metadata.peerDependenciesByVersion[metadata.latestVersion] ?? {})
      : undefined;

    const peerDependencies =
      installed.get(entry.name)?.peerDependencies ??
      (version ? (metadata?.peerDependenciesByVersion[version] ?? {}) : {});

    sources.set(entry.name, {
      name: entry.name,
      version: version ?? "unknown",
      peerDependencies,
      latestPeerDependencies: latestPeers,
    });
  }

  // Transitive packages only ever appear in node_modules, and they raise
  // just as many peer conflicts as direct dependencies do.
  for (const [name, entry] of installed) {
    if (sources.has(name)) {
      continue;
    }
    sources.set(name, {
      name,
      version: entry.version,
      peerDependencies: entry.peerDependencies,
      latestPeerDependencies: undefined,
    });
  }

  return [...sources.values()];
}

/**
 * Finds the peer conflicts that upgrading a package to its newest version
 * would cause.
 * @param name - The package being upgraded.
 * @param latestVersion - The version it would move to, if known.
 * @param peerSources - Packages whose peer requirements could object.
 * @returns The conflicts, or an empty array if there's no upgrade to check.
 */
function conflictsFor(
  name: string,
  latestVersion: string | undefined,
  peerSources: PeerSource[],
): PeerConflict[] {
  if (!latestVersion || peerSources.length === 0) {
    return [];
  }

  return findPeerConflicts(name, latestVersion, peerSources);
}

/**
 * Approximates the version a range resolves to on disk, for use when
 * `node_modules` isn't available to read the real answer from. The lowest
 * version a range admits is the conservative choice: advisories are usually
 * fixed in later versions, so it errs toward reporting an issue that may
 * already be resolved rather than staying silent about a real one.
 * @param specifier - The resolved specifier, if it resolved at all.
 * @returns A concrete version, or `undefined` if the specifier names none.
 */
function lowestVersionIn(specifier: string | undefined): string | undefined {
  if (specifier === undefined || semver.validRange(specifier) === null) {
    return undefined;
  }

  return semver.minVersion(specifier)?.version;
}
