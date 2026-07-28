import * as assert from "assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readInstalledPackages } from "../../../src/npm/installed-packages";

/**
 * Creates a throwaway project directory populated with the given installed
 * manifests.
 * @param packages - Manifests keyed by their path under `node_modules`.
 * @returns The project directory.
 */
async function createProject(
  packages: Record<string, unknown>,
): Promise<string> {
  const projectDir = await mkdtemp(join(tmpdir(), "npm-package-lens-"));

  for (const [path, manifest] of Object.entries(packages)) {
    const packageDir = join(projectDir, "node_modules", path);
    await mkdir(packageDir, { recursive: true });
    await writeFile(
      join(packageDir, "package.json"),
      typeof manifest === "string" ? manifest : JSON.stringify(manifest),
    );
  }

  return projectDir;
}

suite("installed-packages", () => {
  const projectDirs: string[] = [];

  suiteTeardown(async () => {
    await Promise.all(
      projectDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  /**
   * Creates a project and registers it for cleanup.
   * @param packages - Manifests keyed by their path under `node_modules`.
   * @returns The project directory.
   */
  async function project(packages: Record<string, unknown>): Promise<string> {
    const dir = await createProject(packages);
    projectDirs.push(dir);
    return dir;
  }

  test("Reads name, version, and peer dependencies", async () => {
    const dir = await project({
      "some-plugin": {
        name: "some-plugin",
        version: "2.1.0",
        peerDependencies: { vite: "^7.0.0" },
      },
    });

    const installed = await readInstalledPackages(dir);

    assert.deepEqual(installed.get("some-plugin"), {
      name: "some-plugin",
      version: "2.1.0",
      peerDependencies: { vite: "^7.0.0" },
    });
  });

  test("Descends into scoped directories", async () => {
    const dir = await project({
      "@types/node": { name: "@types/node", version: "26.1.2" },
    });

    const installed = await readInstalledPackages(dir);

    assert.equal(installed.get("@types/node")?.version, "26.1.2");
  });

  test("Drops peer dependencies marked optional", async () => {
    const dir = await project({
      plugin: {
        name: "plugin",
        version: "1.0.0",
        peerDependencies: { vite: "^7.0.0", rollup: "^4.0.0" },
        peerDependenciesMeta: { rollup: { optional: true } },
      },
    });

    const installed = await readInstalledPackages(dir);

    assert.deepEqual(installed.get("plugin")?.peerDependencies, {
      vite: "^7.0.0",
    });
  });

  test("Skips npm's own bookkeeping directories", async () => {
    const dir = await project({
      ".bin": { name: "should-be-ignored", version: "1.0.0" },
      lodash: { name: "lodash", version: "4.17.21" },
    });

    const installed = await readInstalledPackages(dir);

    assert.deepEqual([...installed.keys()], ["lodash"]);
  });

  test("Skips manifests that are unparsable or incomplete", async () => {
    const dir = await project({
      broken: "{ not json",
      nameless: { version: "1.0.0" },
      good: { name: "good", version: "1.0.0" },
    });

    const installed = await readInstalledPackages(dir);

    assert.deepEqual([...installed.keys()], ["good"]);
  });

  test("Returns nothing when dependencies haven't been installed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "npm-package-lens-"));
    projectDirs.push(dir);

    assert.equal((await readInstalledPackages(dir)).size, 0);
  });
});
