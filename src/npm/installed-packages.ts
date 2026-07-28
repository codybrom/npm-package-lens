import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** What one package in `node_modules` contributes to the conflict analysis. */
export interface InstalledPackage {
  /** The package's name, as declared in its own manifest. */
  name: string;
  /** The exact version installed. */
  version: string;
  /** The peer dependency ranges that version requires. */
  peerDependencies: Record<string, string>;
}

/** How many installed manifests are read concurrently. */
const MAX_CONCURRENT_READS = 24;

/**
 * Reads every package installed at the top level of `node_modules`.
 *
 * Only the top level is scanned. Nested `node_modules` directories exist to
 * satisfy version conflicts npm has *already* resolved, so including them
 * would report peer requirements that are, by construction, met — while
 * multiplying the number of files read by an order of magnitude.
 *
 * A missing or unreadable `node_modules` yields an empty map rather than
 * throwing: dependencies simply haven't been installed yet, which is a
 * normal state for a freshly cloned project.
 * @param projectDir - The directory containing `node_modules`.
 * @returns The installed packages, keyed by name.
 */
export async function readInstalledPackages(
  projectDir: string,
): Promise<Map<string, InstalledPackage>> {
  const modulesDir = join(projectDir, "node_modules");
  const directories = await listPackageDirectories(modulesDir);

  const installed = new Map<string, InstalledPackage>();
  await forEachWithConcurrency(
    directories,
    MAX_CONCURRENT_READS,
    async (directory) => {
      const entry = await readInstalledManifest(join(modulesDir, directory));
      if (entry) {
        installed.set(entry.name, entry);
      }
    },
  );

  return installed;
}

/**
 * Lists the package directories under `node_modules`, descending one level
 * into `@scope` directories and skipping npm's own bookkeeping entries
 * (`.bin`, `.package-lock.json`, and similar dot-prefixed names).
 * @param modulesDir - The `node_modules` directory to list.
 * @returns Directory names relative to `modulesDir`, e.g. `["semver", "@types/node"]`.
 */
async function listPackageDirectories(modulesDir: string): Promise<string[]> {
  const topLevel = await readDirectories(modulesDir);

  const directories: string[] = [];
  for (const name of topLevel) {
    if (name.startsWith(".")) {
      continue;
    }
    if (!name.startsWith("@")) {
      directories.push(name);
      continue;
    }
    for (const scoped of await readDirectories(join(modulesDir, name))) {
      directories.push(`${name}/${scoped}`);
    }
  }

  return directories;
}

/**
 * Lists subdirectory names, treating an unreadable path as empty.
 * @param path - The directory to list.
 * @returns The subdirectory names, or an empty array if `path` can't be read.
 */
async function readDirectories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Reads one installed package's manifest.
 * @param packageDir - The installed package's directory.
 * @returns Its name, version, and peer dependencies, or `undefined` if the manifest is missing, unreadable, or incomplete.
 */
async function readInstalledManifest(
  packageDir: string,
): Promise<InstalledPackage | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(packageDir, "package.json"), "utf8");
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }

  const manifest = parsed as {
    name?: unknown;
    version?: unknown;
    peerDependencies?: unknown;
    peerDependenciesMeta?: unknown;
  };
  if (
    typeof manifest.name !== "string" ||
    typeof manifest.version !== "string"
  ) {
    return undefined;
  }

  return {
    name: manifest.name,
    version: manifest.version,
    peerDependencies: requiredPeerDependencies(
      manifest.peerDependencies,
      manifest.peerDependenciesMeta,
    ),
  };
}

/**
 * Reads the peer dependency ranges a manifest genuinely requires, dropping
 * any marked optional in `peerDependenciesMeta` — npm won't fail an install
 * over those, so neither should the conflict analysis.
 * @param peerDependencies - The manifest's raw `peerDependencies` field.
 * @param peerDependenciesMeta - The manifest's raw `peerDependenciesMeta` field.
 * @returns The required ranges, keyed by package name.
 */
function requiredPeerDependencies(
  peerDependencies: unknown,
  peerDependenciesMeta: unknown,
): Record<string, string> {
  if (typeof peerDependencies !== "object" || peerDependencies === null) {
    return {};
  }

  const meta = (
    typeof peerDependenciesMeta === "object" && peerDependenciesMeta !== null
      ? peerDependenciesMeta
      : {}
  ) as Record<string, { optional?: unknown } | undefined>;

  const required: Record<string, string> = {};
  for (const [name, range] of Object.entries(
    peerDependencies as Record<string, unknown>,
  )) {
    if (typeof range === "string" && meta[name]?.optional !== true) {
      required[name] = range;
    }
  }

  return required;
}

/**
 * Runs `fn` over every item with at most `concurrency` calls in flight.
 * Results are discarded, so unlike a mapping helper this imposes no ordering
 * on completion.
 * @template T - The item type.
 * @param items - The items to process.
 * @param concurrency - The maximum number of concurrent `fn` calls.
 * @param fn - The async function to run per item.
 */
async function forEachWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex++;
      const item = items[index];
      if (item === undefined) {
        return;
      }
      await fn(item);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
}
