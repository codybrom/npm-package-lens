import {
  CancellationToken,
  Hover,
  HoverProvider,
  MarkdownString,
  Position,
  TextDocument,
} from "vscode";
import { formatRelativeTime } from "../format";
import { getDownloadCount, getRegistryMetadata } from "../npm/registry-client";
import {
  classifySpecifier,
  getBumpSeverity,
  resolveInstalledVersion,
} from "../npm/version-diff";
import { BumpSeverity, PackageMetadata } from "../types";

const RESERVED_PACKAGE_JSON_KEYS = new Set([
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "name",
  "version",
  "scripts",
]);

const BUMP_LABEL: Record<BumpSeverity, string> = {
  major: "$(error) major update",
  minor: "$(warning) minor update",
  patch: "$(info) patch update",
  none: "$(pass) up to date",
  unsupported: "$(circle-slash) not comparable",
};

/**
 * Provides rich hover tooltips for dependency entries in `package.json`,
 * showing update status, version comparison, download count, and
 * description — sourced live from the npm registry.
 */
export class NpmHoverProvider implements HoverProvider {
  /** @inheritdoc */
  provideHover(
    document: TextDocument,
    position: Position,
    token: CancellationToken,
  ): Thenable<Hover | undefined> {
    const packageName = getPackageNameAtPosition(document, position);
    if (!packageName) {
      return Promise.resolve(undefined);
    }

    return getPackageMetadata(packageName, document, position, token).then(
      (metadata) => {
        if (!metadata || token.isCancellationRequested) {
          return undefined;
        }

        return new Hover(buildHoverMarkdown(metadata));
      },
    );
  }
}

/**
 * Renders a package's metadata as VS Code hover markdown, with the update
 * severity color-coded to match the editor's error/warning/info theme
 * colors.
 *
 * Exported for unit testing; not part of the extension's public API.
 * @param metadata - The resolved package metadata to render.
 * @returns A {@link MarkdownString} with theme icons and HTML color spans enabled.
 */
export function buildHoverMarkdown(metadata: PackageMetadata): MarkdownString {
  const bump = getBumpSeverity(
    metadata.resolvedInstalledVersion,
    metadata.latestVersion,
  );

  const latest = `\`${metadata.latestVersion}\``;
  const versions =
    bump !== "none" && metadata.installedVersion
      ? `\`${metadata.installedVersion}\` → ${colorSpan(latest, bumpColor(bump))}`
      : latest;

  const versionLine = [`${versions} ${statusBadge(bump)}`];

  const publishedAgo = formatRelativeTime(metadata.latestVersionPublishedAt);
  if (publishedAgo) {
    versionLine.push(mutedSpan(`published ${publishedAgo}`));
  }

  const lines = [`**${metadata.name}**`, versionLine.join(" · ")];

  const description = cleanDescription(metadata.description);
  if (description) {
    lines.push(description);
  }

  const links = buildLinks(metadata);
  if (links) {
    lines.push(links);
  }

  const markdown = new MarkdownString(lines.join("\n\n"));
  markdown.supportThemeIcons = true;
  markdown.supportHtml = true;
  return markdown;
}

/**
 * Builds the row shown at the bottom of a hover: links to the package's npm
 * page (always present), homepage, and source repository when the registry
 * publishes them and they're not simply duplicates of each other, followed
 * by the monthly download count in the same muted style as "up to date".
 *
 * Rendered as HTML rather than markdown link syntax: once a
 * {@link MarkdownString} contains any raw HTML (this one does, for the
 * color-coded status badge), VS Code's renderer can fail to parse markdown
 * link syntax elsewhere in the same string — see
 * {@link https://github.com/microsoft/vscode/issues/140686}. Mixing HTML
 * throughout avoids that failure mode.
 * @param metadata - The package metadata to link out from.
 * @returns An HTML line of `·`-separated links and stats.
 */
function buildLinks(metadata: PackageMetadata): string {
  const npmUrl = `https://www.npmjs.com/package/${encodeURIComponent(metadata.name)}`;
  const links = [htmlLink(npmUrl, "npm")];

  if (metadata.repositoryUrl) {
    links.push(htmlLink(metadata.repositoryUrl, "Repository"));
  }

  if (metadata.homepage && metadata.homepage !== metadata.repositoryUrl) {
    links.push(htmlLink(metadata.homepage, "Website"));
  }

  if (metadata.downloads) {
    links.push(mutedSpan(`${metadata.downloads} downloads/mo`));
  }

  return links.join(" · ");
}

/**
 * Builds an HTML anchor tag for use inside an HTML-enabled {@link MarkdownString}.
 * @param href - The link target. Must already be a well-formed URL.
 * @param label - The visible link text.
 * @returns The `<a>` tag.
 */
function htmlLink(href: string, label: string): string {
  return `<a href="${href}">${label}</a>`;
}

/**
 * Resolves the VS Code editor theme color CSS variable for a given
 * {@link BumpSeverity}, so hover text renders in the same red/yellow/blue
 * the editor already uses for errors, warnings, and info. Up-to-date
 * packages use a faded, low-emphasis color rather than a loud green, since
 * "nothing to do here" shouldn't compete for attention with real updates.
 * @param bump - The severity to look up a color for.
 * @returns A `var(--vscode-...)` CSS color expression.
 */
const MUTED_COLOR = "var(--vscode-disabledForeground)";

function bumpColor(bump: BumpSeverity): string {
  switch (bump) {
    case "major":
      return "var(--vscode-errorForeground)";
    case "minor":
      return "var(--vscode-editorWarning-foreground)";
    case "patch":
      return "var(--vscode-editorInfo-foreground)";
    case "none":
    case "unsupported":
      return MUTED_COLOR;
  }
}

/**
 * Builds the color-coded status badge (e.g. "⚠ minor update") shown at the
 * start of a hover.
 * @param bump - The severity to render a badge for.
 * @returns An HTML span with the badge's icon, label, and color.
 */
function statusBadge(bump: BumpSeverity): string {
  return colorSpan(BUMP_LABEL[bump], bumpColor(bump));
}

/**
 * Wraps `text` in an inline-styled HTML `<span>`. Requires the containing
 * {@link MarkdownString} to have `supportHtml` enabled.
 * @param text - The (already-escaped) markdown/HTML content to color.
 * @param color - A CSS color value, typically a `var(--vscode-...)` expression.
 * @returns The wrapped HTML string.
 */
function colorSpan(text: string, color: string): string {
  return `<span style="color:${color};">${text}</span>`;
}

/**
 * Wraps `text` in the same faded, low-emphasis color used for an "up to
 * date" status, for secondary details (e.g. "published 3 days ago",
 * download counts) that shouldn't compete visually with the update status.
 * @param text - The (already-escaped) markdown/HTML content to color.
 * @returns The wrapped HTML string.
 */
function mutedSpan(text: string): string {
  return colorSpan(text, MUTED_COLOR);
}

/**
 * Matches a markdown image wrapped in a link — `[![alt](img-url)](link-url)`
 * — as commonly used for npm/CI status badges (shields.io, etc.) at the top
 * of a README, which npm sometimes carries over into `description`.
 */
const LINKED_IMAGE_REGEX = /\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g;

/** Matches a bare markdown image — `![alt](url)`. */
const IMAGE_REGEX = /!\[[^\]]*\]\([^)]*\)/g;

/**
 * Matches a truncated/dangling badge fragment at the end of a string — an
 * unclosed `[![alt](url` or `![alt](url` — left over when npm's registry
 * truncates a description mid-badge. Must run *after*
 * {@link LINKED_IMAGE_REGEX} and {@link IMAGE_REGEX} have removed every
 * complete* badge, otherwise it can misfire on the last complete badge in
 * a string that also ends with a truncated one.
 */
const DANGLING_BADGE_TAIL_REGEX = /\s*\[?!?\[[^\]]*\]?\([^)]*$/;

/**
 * Prepares a package description for display: strips markdown image/badge
 * syntax (shields.io-style CI/version/download badges are common at the top
 * of a README and sometimes leak into the registry `description` field,
 * including truncated/broken mid-badge when npm itself cuts the field
 * short) and collapses the whitespace left behind. The result is otherwise
 * shown in full — no length cap — since real descriptive text should read
 * completely, not get cut off arbitrarily.
 * @param description - The raw description text, if any.
 * @returns The cleaned description, or `undefined` if empty or blank once cleaned.
 */
function cleanDescription(description?: string): string | undefined {
  if (!description) {
    return undefined;
  }

  const cleaned = description
    .replace(LINKED_IMAGE_REGEX, "")
    .replace(IMAGE_REGEX, "")
    .replace(DANGLING_BADGE_TAIL_REGEX, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  return cleaned || undefined;
}

/**
 * Resolves full display metadata for a package by combining the installed
 * version range (read from the document at `position`) with live registry
 * data.
 * @param packageName - The package name under the cursor.
 * @param document - The `package.json` document being hovered.
 * @param position - The cursor position within `document`.
 * @param token - Cancellation token forwarded to the underlying registry requests.
 * @returns The combined metadata, or `undefined` if the registry lookup failed.
 */
function getPackageMetadata(
  packageName: string,
  document: TextDocument,
  position: Position,
  token: CancellationToken,
): Promise<PackageMetadata | undefined> {
  const installedVersion = getInstalledVersion(document, position);

  return Promise.all([
    getRegistryMetadata(packageName, token),
    getDownloadCount(packageName, token),
  ])
    .then(([metadata, downloads]) => {
      if (!metadata) {
        return undefined;
      }

      const resolvedInstalledVersion = installedVersion
        ? resolveInstalledVersion(
            classifySpecifier(installedVersion),
            metadata.distTags,
          )
        : undefined;

      return {
        name: metadata.name ?? packageName,
        installedVersion,
        resolvedInstalledVersion,
        latestVersion: metadata.latestVersion ?? "unknown",
        description: metadata.description ?? "",
        downloads,
        homepage: metadata.homepage,
        repositoryUrl: metadata.repositoryUrl,
        latestVersionPublishedAt: metadata.latestVersionPublishedAt,
      };
    })
    .catch(() => undefined);
}

/**
 * Reads the version string declared on the line at `position`, e.g. the
 * `"^1.2.3"` in `"lodash": "^1.2.3"`.
 * @param document - The document to read from.
 * @param position - The line to read.
 * @returns The declared version range, or `undefined` if the line doesn't match a `"key": "value"` pattern.
 */
function getInstalledVersion(
  document: TextDocument,
  position: Position,
): string | undefined {
  const line = document.lineAt(position.line).text;
  const match = /"[^"]+"\s*:\s*"([^"]+)"/.exec(line);
  return match?.[1];
}

/**
 * Determines the package name for the line under the cursor, if any.
 *
 * Triggers anywhere on a `"name": "range"` dependency line — the key, the
 * value, or the surrounding whitespace — rather than only the exact span of
 * one quoted string, so hovering the version specifier resolves to the
 * package it belongs to instead of being (incorrectly) treated as its own
 * lookup target. Note that VS Code's hover API cannot be triggered by
 * hovering the inline decoration text {@link ../features/dependency-decorations.ts}
 * renders past end-of-line — that's a platform limitation
 * ({@link https://github.com/microsoft/vscode/issues/105302}), not something
 * addressable here.
 * @param document - The candidate document; non-`package.json` documents always return `undefined`.
 * @param position - The cursor position to check.
 * @returns The package name, or `undefined` if the line isn't a dependency entry.
 */
function getPackageNameAtPosition(
  document: TextDocument,
  position: Position,
): string | undefined {
  if (!isSupportedDocument(document)) {
    return undefined;
  }

  return packageNameForLine(document.lineAt(position.line).text);
}

/**
 * Extracts the package name from a single `package.json` line, if that line
 * is a dependency entry (`"name": "range"`) and not a reserved top-level key.
 *
 * Exported for testing; not part of the extension's public API.
 * @param line - The line's full text.
 * @returns The package name, or `undefined` if the line isn't a dependency entry.
 */
export function packageNameForLine(line: string): string | undefined {
  const entryMatch = /^\s*"([^"]+)"\s*:\s*"([^"]*)"/.exec(line);
  const packageName = entryMatch?.[1];
  if (!packageName || RESERVED_PACKAGE_JSON_KEYS.has(packageName)) {
    return undefined;
  }

  return packageName;
}

/**
 * Checks whether `document` is a `package.json` file this provider should
 * activate on.
 * @param document - The document to check.
 * @returns `true` if the document is a JSON/JSONC file named `package.json`.
 */
function isSupportedDocument(document: TextDocument): boolean {
  return (
    document.fileName.endsWith("package.json") &&
    ["json", "jsonc"].includes(document.languageId)
  );
}
