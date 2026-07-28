# npm Package Lens

Surfaces outdated dependencies directly in `package.json` — on hover and inline.

## Features

### Hover

Hover over any dependency name or version string in `package.json` to see:

- Whether it's up to date, and the severity of the available update (major/minor/patch), color-coded
- The installed range and latest published version
- Monthly download count
- The package description

### Inline annotations

When a `package.json` file is open, each dependency line gets an inline annotation at the end of the line showing its update status, colored to match its severity — similar to GitLens blame annotations. Annotations refresh when the file is opened or saved.

## How it works

Version comparisons are computed from the npm registry's `dist-tags.latest` against the version range declared in `package.json`, using the same "which part changed" logic as [npm-check-updates](https://github.com/raineorshine/npm-check-updates): the range operator is stripped from both sides, then the remaining version parts are diffed positionally. Packages on a `0.x` major version are always flagged as a major-risk update, since semver makes no compatibility guarantee below `1.0.0`. Non-semver specifiers (git URLs, `workspace:*`, `file:`, etc.) are left unannotated rather than guessed at.

## Architecture

```txt
src/
  extension.ts                        Activation entry point
  types.ts                            Shared types (BumpSeverity, RegistryMetadata, PackageMetadata)
  npm/
    registry-client.ts                Fetches + Zod-validates npm registry responses
    version-diff.ts                   Pure semver bump-severity comparison
  features/
    hover-provider.ts                 Hover UI
    dependency-decorations.ts         Inline end-of-line annotations
```

Each module has a single responsibility: `npm/` contains no VS Code API usage and no UI concerns; `features/` contains no direct `fetch` calls, consuming `npm/` instead.

Tests are split into two tiers, mirroring that boundary:

```txt
test/
  unit/          Plain Node + Mocha, no Extension Host — tests everything under src/npm/
    npm/
  suite/         VS Code Extension Development Host — tests everything under src/features/
    features/
```

`test/unit` runs in milliseconds via `npm run test:unit` since it never touches the `vscode` module at runtime (registry-client.ts's only `vscode` import is a type-only `CancellationToken`, erased at compile time). `test/suite` needs a real editor and window APIs, so it launches through `@vscode/test-electron`.

## Development

```sh
npm install
npm run compile       # tsc build
npm run watch          # tsc --watch
npm run test:unit      # fast: plain Node, src/npm/** only
npm test               # slower: compiles + launches an Extension Development Host
npm run test:all        # both tiers
npm run typecheck      # tsc --noEmit
npm run lint            # eslint (strict, type-checked, JSDoc-enforced)
npm run lint:fix
npm run format          # prettier --write
npm run format:check
```

All exported functions, classes, and types require a JSDoc block (enforced via `eslint-plugin-jsdoc`), and the TypeScript config runs with `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes` enabled.

## License

This software is released under [MIT License](http://www.opensource.org/licenses/mit-license.php)
