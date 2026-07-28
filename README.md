# npm Package Lens

[![CI](https://github.com/codybrom/npm-package-lens/actions/workflows/main.yml/badge.svg)](https://github.com/codybrom/npm-package-lens/actions/workflows/main.yml)
[![Release](https://github.com/codybrom/npm-package-lens/actions/workflows/publish.yml/badge.svg)](https://github.com/codybrom/npm-package-lens/actions/workflows/publish.yml)
[![VS Marketplace](https://img.shields.io/github/package-json/v/codybrom/npm-package-lens?label=VS%20Marketplace&logo=visualstudiocode&color=blue)](https://marketplace.visualstudio.com/items?itemName=codybrom.npm-package-lens)
[![Open VSX version](https://img.shields.io/open-vsx/v/codybrom/npm-package-lens?label=Open%20VSX)](https://open-vsx.org/extension/codybrom/npm-package-lens)
[![License: MIT](https://img.shields.io/badge/license-MIT-informational)](LICENSE)

Everything you need to know about a dependency, in `package.json` — what's outdated, what's blocked, and what's vulnerable — with one click to fix it.

**[Install from the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=codybrom.npm-package-lens)** · **[Install from Open VSX](https://open-vsx.org/extension/codybrom/npm-package-lens)**

## Features

### Inline annotations

Every dependency gets an end-of-line annotation, colored to match its severity:

| Annotation                           | Meaning                                               |
| ------------------------------------ | ----------------------------------------------------- |
| `✓ up to date`                       | Already on the newest published version               |
| `⬆ 7.9.1 (major) — 4 days ago`       | An update is available, and how long it's been out    |
| `✋ 8.1.0 blocked by vite-plugin-x`  | A peer requirement would break if you took the update |
| `⚠ 2 advisories · ⬆ 4.17.21 (patch)` | The version in use has known security advisories      |
| `⊘ deprecated`                       | The publisher has deprecated the version in use       |

### Peer dependency conflicts

Before an upgrade shows up as safe, it's checked against the peer requirements of everything
else in the project — both what's installed in `node_modules` and what's declared in the
manifest. If upgrading `vite` would break `vite-plugin-sass-glob-import`, you see that in the
manifest rather than in a failed `npm install`.

The hover goes one step further and tells you whether the blocker's _own_ latest release has
relaxed its requirement — the difference between "upgrade both together" and "wait for
upstream".

### Vulnerability checks

Packages are checked against the [OSV](https://osv.dev) advisory database. Affected versions
get a red squiggle in the editor and an entry in the Problems panel, with the advisory link
and fix version on hover. Clicking an update that would move onto a version with a known
advisory asks for confirmation first.

### CodeLens version suggestions

Dependencies that need attention get their own row of clickable suggestions: what the
declared range resolves to today, what it could be updated to, and two ways to take it —
**Update to 4.7.15** rewrites the specifier and saves the file, **Install Update** does that
and runs the install step.

A blocked dependency gets a third option, since taking the newest version isn't the only
sensible move:

```txt
🟡 Resolved as 9.39.5 | ✋ 10.8.0 blocked by 2 dependencies | Install Blocked Update
```

**Resolved as** pins the manifest to the version you already have — the safe action while a
peer conflict stands. The other two take the blocked version anyway, which npm's
`--legacy-peer-deps` and a coordinated upgrade both make reasonable.
Editing several dependencies and installing once is the common case, so neither hides behind
the other. Updates keep your range operator: `~1.2.3` becomes `~2.0.0`, not `2.0.0`.

Rows that are already on the newest version show nothing, so the suggestions mark out only
what's worth acting on. Set `npmPackageLens.codeLens.showUpToDate` to `true` if you'd rather
see them confirmed.

The **V** icon in the editor toolbar hides and re-shows them, for when you want the manifest
uncluttered. Set `npmPackageLens.codeLens.showOnStartup` to `false` to start with only the
section summaries.

The **tag** icon adds prerelease suggestions, optionally filtered to specific tags.

Each dependency section also gets a summary lens (`▲ 5 updates available · 1 blocked`), which
is itself clickable to update everything in the file that isn't blocked.

### Hover

Hover any dependency for update status, the installed-to-latest transition, monthly download
count, description, deprecation notices, advisories, blockers, and links to npm, the
repository, and the homepage.

### Status bar

A summary of the active manifest (`npm 5↑ 1✋ 2⚠`), which turns amber when something is
blocked or vulnerable. Click it to re-check.

### Sidebar dashboard

A dedicated view grouping dependencies by section, with current and latest versions, a status
badge, expandable blocker and advisory details, per-package **Upgrade** and **⇩** (upgrade
and install) buttons, and bulk
**Upgrade all** / **Patches only** actions. Clicking a package name jumps to its line in the
manifest.

## Commands

All commands are under the **npm Package Lens** category.

| Command                                      | Description                                                     |
| -------------------------------------------- | --------------------------------------------------------------- |
| Check for dependency updates                 | Re-analyze the active manifest                                  |
| Refresh dependency data                      | Clear the cache and re-fetch everything                         |
| Show / Hide version suggestions              | Toggle the per-dependency CodeLens                              |
| Show / Hide prerelease versions              | Toggle prerelease suggestions                                   |
| Update all dependencies to latest            | Apply every available update that isn't blocked                 |
| Update dependencies (major/minor/patch only) | Apply only updates of that severity                             |
| Sort dependencies alphabetically             | Sort each dependency section in place                           |
| Run install for this package.json            | Run the configured install task, or `npm install` in a terminal |

## Settings

| Setting                                          | Default                      | Description                                                          |
| ------------------------------------------------ | ---------------------------- | -------------------------------------------------------------------- |
| `npmPackageLens.registryUrl`                     | `https://registry.npmjs.org` | Registry queried for versions; point at a private registry if needed |
| `npmPackageLens.cacheDuration`                   | `10`                         | Cache lifetime in minutes; `0` disables caching                      |
| `npmPackageLens.files`                           | `**/package.json`            | Glob selecting which files are treated as manifests                  |
| `npmPackageLens.dependencyProperties`            | see below                    | Property paths parsed as dependency maps                             |
| `npmPackageLens.checkOnOpen`                     | `true`                       | Check for updates when a manifest is opened                          |
| `npmPackageLens.decorations.enabled`             | `true`                       | Show inline annotations                                              |
| `npmPackageLens.decorations.showUpToDate`        | `true`                       | Annotate up-to-date dependencies too                                 |
| `npmPackageLens.codeLens.enabled`                | `true`                       | Show version suggestions                                             |
| `npmPackageLens.codeLens.showOnStartup`          | `true`                       | Start with per-dependency suggestions visible                        |
| `npmPackageLens.codeLens.showSectionSummaries`   | `true`                       | Show a summary above each section                                    |
| `npmPackageLens.codeLens.showUpToDate`           | `false`                      | Show suggestions on dependencies already on the newest version       |
| `npmPackageLens.prereleases.showOnStartup`       | `false`                      | Start with prereleases visible                                       |
| `npmPackageLens.prereleases.tagFilter`           | `[]`                         | Prerelease tags to show; empty shows all                             |
| `npmPackageLens.suggestions.indicators`          | emoji set                    | Glyphs shown before each suggestion                                  |
| `npmPackageLens.statusBar.enabled`               | `true`                       | Show the status bar summary                                          |
| `npmPackageLens.peerDependencies.checkConflicts` | `true`                       | Check peer dependency conflicts                                      |
| `npmPackageLens.vulnerabilities.enabled`         | `true`                       | Check packages against OSV                                           |
| `npmPackageLens.onSaveChanges`                   | _(unset)_                    | `tasks.json` task label to run when saved dependencies change        |
| `npmPackageLens.runInstallAfterUpgrade`          | `true`                       | Run the install step after the bulk update commands                  |

`dependencyProperties` defaults to `dependencies`, `devDependencies`, `peerDependencies`,
`optionalDependencies`, `overrides`, `overrides.*`, `resolutions`, `pnpm.overrides`,
`pnpm.overrides.*`, and the four `jspm.*` maps. A `*` segment matches any single property
name. `engines` and the top-level `packageManager` field are always parsed.

## How it works

Version comparisons are computed from the registry's `dist-tags.latest` against the range
declared in `package.json`, using the same "which part changed" logic as
[npm-check-updates](https://github.com/raineorshine/npm-check-updates): the range operator is
stripped from both sides, then the remaining version parts are diffed positionally. Packages
on a `0.x` major version are always flagged as a major-risk update, since semver makes no
compatibility guarantee below `1.0.0`. Non-semver specifiers (git URLs, `workspace:*`,
`file:`, etc.) are left unannotated rather than guessed at.

Peer conflicts are evaluated with [node-semver](https://github.com/npm/node-semver) against
the peer ranges of every top-level package in `node_modules`, plus the registry's peer data
for anything declared but not installed. Optional peers are ignored, since npm won't fail an
install over them.

Vulnerabilities come from OSV's batch API, queried for the version actually installed where
`node_modules` can be read, and for the lowest version the declared range admits otherwise.

## Architecture

```txt
src/
  extension.ts                 Activation: builds the analyzer, wires each feature to it
  config.ts                    Typed access to every contributed setting
  types.ts                     Shared domain types
  format.ts                    Relative-time formatting
  parse/
    package-document.ts        Pure manifest parser (offsets, not editor ranges)
  npm/                         No VS Code API usage, no UI concerns
    registry-client.ts         Registry documents, Zod-validated
    nodejs-releases.ts         Node.js LTS release lookup
    installed-packages.ts      Reads node_modules for installed versions and peers
    version-diff.ts            Specifier classification and bump severity
    suggestions.ts             Version suggestion lists
    peer-conflicts.ts          Which packages object to an upgrade, and why
    vulnerabilities.ts         OSV advisory lookup
  analysis/
    analyzer.ts                One pass: parse, fetch, analyze, cache, notify
  features/                    No direct fetches; every feature reads the analyzer
    presentation.ts            Status, colors, annotation text, summaries
    manifest-documents.ts      Manifest matching and offset-to-range conversion
    manifest-edits.ts          Specifier rewrites and section sorting
    dependency-decorations.ts  Inline end-of-line annotations
    hover-provider.ts          Hover UI
    code-lens-provider.ts      Version suggestions and section summaries
    diagnostics.ts             Advisory and deprecation squiggles
    status-bar.ts              Status bar summary
    panel-view.ts              Sidebar dashboard webview
    commands.ts                Every contributed command
    view-state.ts              Suggestion and prerelease visibility toggles
```

Every feature is a view onto one `DependencyAnalyzer`: it owns fetching, caching, and
analysis, and emits a change event that each feature repaints from. That's what keeps a
manifest's dependencies fetched once per cache window instead of once per feature.

Tests are split into two tiers, mirroring the `npm/`–`features/` boundary:

```txt
test/
  unit/          Plain Node + Mocha, no Extension Host
    npm/         Registry, advisories, peers, suggestions, installed packages
    parse/       Manifest parsing
    features/    The pure presentation layer
  suite/         VS Code Extension Development Host
    features/    Anything that constructs real editor objects
```

`test/unit` runs in milliseconds via `npm run test:unit` since it never touches the `vscode`
module at runtime. `test/suite` needs a real editor, so it launches through
`@vscode/test-electron`.

## Development

```sh
npm install
npm run compile       # tsc build
npm run watch          # tsc --watch
npm run test:unit      # fast: plain Node
npm test               # slower: compiles + launches an Extension Development Host
npm run test:all        # both tiers
npm run typecheck      # tsc --noEmit
npm run lint            # eslint (strict, type-checked, JSDoc-enforced)
npm run lint:fix
npm run format          # prettier --write
npm run format:check
```

All exported functions, classes, and types require a JSDoc block (enforced via
`eslint-plugin-jsdoc`), and the TypeScript config runs with `strict`,
`noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes` enabled.

## License

This software is released under [MIT License](http://www.opensource.org/licenses/mit-license.php)
