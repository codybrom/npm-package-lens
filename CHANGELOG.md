# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-07-28

### Added

- Peer dependency conflict detection: upgrades that would violate another package's peer requirement are flagged inline, naming the blocking package and whether upgrading it too would resolve the conflict
- Vulnerability checks against the [OSV](https://osv.dev) advisory database, reported as editor diagnostics and on hover; a dependency whose current version carries an advisory has its update marked as such, and updating _onto_ a version with a known advisory prompts for confirmation first
- CodeLens version suggestions on each dependency's own line, offering both **Update to x.y.z** (rewrite the specifier and save) and **Install Update** (do that and run the install step); a blocked dependency additionally offers **Resolved as x.y.z**, pinning the manifest to the version already installed, and the whole row is hideable from the editor toolbar
- Suggestions are omitted for dependencies already on the newest version, so they mark out only the rows worth acting on; `npmPackageLens.codeLens.showUpToDate` brings them back
- CodeLens summary above each dependency section, clickable to update everything in the file that isn't blocked
- Prerelease suggestions, toggled from the editor toolbar and filterable by tag
- Status bar summary of the active `package.json`, showing available, blocked, and vulnerable counts
- Sidebar dashboard grouping dependencies by section, with per-package and bulk upgrades, blocker and advisory details, and click-to-reveal
- Commands: check for updates, refresh (clearing the cache), show/hide version suggestions, show/hide prereleases, update all/major/minor/patch, sort dependencies alphabetically, and run install
- Every update action preserves the declared range operator, and leaves alone the specifiers no single version substitution preserves — wildcards, and compound ranges like `>=1 <2` or `^1 || ^2`
- Deprecation notices from the registry, shown inline, on hover, and as a diagnostic
- Settings covering the registry URL, cache duration, manifest glob, parsed dependency properties, suggestion indicators, each feature's visibility, and whether the bulk update commands install afterwards
- Support for a custom `tasks.json` install task, run in place of `npm install` wherever an install happens, and run on its own when a saved `package.json` has changed dependencies. Saving runs nothing unless that task is configured — the install fallback belongs to the update actions, which is where it was asked for

### Changed

- `package.json` is now parsed with a real JSON parser rather than line-by-line, which adds support for nested `overrides`, `pnpm.overrides`, `jspm.*`, and `resolutions`, and keeps annotations correct in manifests with unusual formatting
- All features now read from one shared analysis pass, so a manifest's dependencies are fetched once per cache window rather than once per feature
- `engines` entries for package managers, and the `packageManager` field, are resolved against the npm registry; `engines.node` continues to resolve against the Node.js release index
- Registry lookups honor a configurable registry URL, so private registries work

## [0.1.0] - 2026-07-28

### Added

- Hover provider showing update severity (major/minor/patch), installed vs. latest version, download count, and description for dependencies in `package.json`
- Inline annotations on each dependency line in `package.json`, refreshed on open/save

[Unreleased]: https://github.com/codybrom/npm-package-lens/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/codybrom/npm-package-lens/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/codybrom/npm-package-lens/releases/tag/v0.1.0
