const esbuild = require("esbuild");

const watch = process.argv.includes("--watch");

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  target: "node20",
  format: "cjs",
  external: ["vscode"],
  // Prefer each dependency's ESM build over its CommonJS one. jsonc-parser
  // ships a UMD `main`, whose `require` calls sit inside a factory function
  // and so survive bundling as runtime requires against paths that don't
  // exist in dist/ — the extension then fails to activate. Its ESM build has
  // static imports esbuild can follow. Dependencies without a `module` field
  // (semver, semver-utils) still resolve through `main`.
  mainFields: ["module", "main"],
  sourcemap: true,
  minify: !watch,
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log("Watching for changes...");
    return;
  }

  await esbuild.build(options);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
