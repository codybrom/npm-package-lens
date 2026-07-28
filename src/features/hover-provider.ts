import {
  CancellationToken,
  Hover,
  HoverProvider,
  MarkdownString,
  Position,
  TextDocument,
} from "vscode";
import type { DependencyAnalyzer } from "../analysis/analyzer";
import { formatRelativeTime } from "../format";
import { getDownloadCount } from "../npm/registry-client";
import { isManifest } from "./manifest-documents";
import {
  displayStateOf,
  themeColorVariable,
  type DisplayState,
} from "./presentation";
import type { DependencyStatus, PeerConflict, Vulnerability } from "../types";

/** The badge shown at the top of a hover, per display state. */
const STATE_LABEL: Record<DisplayState, string> = {
  vulnerable: "$(shield) known vulnerability",
  blocked: "$(circle-slash) update blocked",
  deprecated: "$(warning) deprecated",
  major: "$(error) major update",
  minor: "$(warning) minor update",
  patch: "$(info) patch update",
  upToDate: "$(pass) up to date",
  unknown: "$(circle-slash) not comparable",
};

/** The faded color used for details that shouldn't compete for attention. */
const MUTED_COLOR = "var(--vscode-disabledForeground)";

/**
 * Provides rich hover tooltips for dependency entries in `package.json`,
 * showing update status, peer conflicts, advisories, download count, and
 * description.
 *
 * Everything but the download count comes from the shared analysis, so
 * hovering costs at most one network request — and none at all once a
 * package's downloads have been read once.
 */
export class NpmHoverProvider implements HoverProvider {
  private readonly downloadCounts = new Map<string, string | undefined>();

  /**
   * @param analyzer - The analyzer supplying dependency statuses.
   */
  constructor(private readonly analyzer: DependencyAnalyzer) {}

  /** @inheritdoc */
  async provideHover(
    document: TextDocument,
    position: Position,
    token: CancellationToken,
  ): Promise<Hover | undefined> {
    if (!isManifest(document)) {
      return undefined;
    }

    const cached = this.analyzer.get(document.uri);
    const analysis =
      cached?.documentVersion === document.version
        ? cached
        : await this.analyzer.analyze(document);

    if (isCancelled(token)) {
      return undefined;
    }

    const status = analysis.statuses.find(
      (candidate) =>
        document.positionAt(candidate.entry.nameRange.start).line ===
        position.line,
    );
    if (!status) {
      return undefined;
    }

    const downloads = await this.getDownloads(status, token);
    if (isCancelled(token)) {
      return undefined;
    }

    return new Hover(buildHoverMarkdown(status, downloads));
  }

  /**
   * Resolves a package's monthly download count, remembering the answer —
   * including a failed lookup — so repeated hovers don't re-request it.
   * @param status - The dependency being hovered.
   * @param token - Cancellation token forwarded to the request.
   * @returns The formatted count, or `undefined` if unavailable.
   */
  private async getDownloads(
    status: DependencyStatus,
    token: CancellationToken,
  ): Promise<string | undefined> {
    const name = status.entry.name;
    if (status.entry.source === "node") {
      return undefined;
    }
    if (this.downloadCounts.has(name)) {
      return this.downloadCounts.get(name);
    }

    const downloads = await getDownloadCount(name, token).catch(
      () => undefined,
    );
    if (!isCancelled(token)) {
      this.downloadCounts.set(name, downloads);
    }
    return downloads;
  }
}

/**
 * Reads a token's cancellation state.
 *
 * Wrapped in a function deliberately: read inline, the type checker narrows
 * the property after the first check and treats every later one as dead
 * code — but the token really can be cancelled while an intervening request
 * is in flight, which is exactly when these checks matter.
 * @param token - The token to read.
 * @returns `true` if cancellation has been requested.
 */
function isCancelled(token: CancellationToken): boolean {
  return token.isCancellationRequested;
}

/**
 * Renders a dependency's analyzed state as VS Code hover markdown, with the
 * status color-coded to match the editor's error/warning/info theme colors.
 *
 * Exported for testing; not part of the extension's public API.
 * @param status - The analyzed dependency to render.
 * @param downloads - The formatted monthly download count, if known.
 * @returns A {@link MarkdownString} with theme icons, HTML, and command links enabled.
 */
export function buildHoverMarkdown(
  status: DependencyStatus,
  downloads?: string,
): MarkdownString {
  const state = displayStateOf(status);
  const color = themeColorVariable(state);
  const name = status.entry.name;
  const latest = status.latestVersion;

  const versions =
    latest === undefined
      ? `\`${status.entry.specifier}\``
      : state === "upToDate"
        ? `\`${latest}\``
        : `\`${status.entry.specifier}\` → ${colorSpan(`\`${latest}\``, color)}`;

  const heading = [`${versions} ${colorSpan(STATE_LABEL[state], color)}`];
  const publishedAgo = formatRelativeTime(
    status.metadata?.latestVersionPublishedAt,
  );
  if (publishedAgo !== undefined) {
    heading.push(mutedSpan(`published ${publishedAgo}`));
  }

  const lines = [`**${name}**`, heading.join(" · ")];

  if (status.deprecation !== undefined) {
    lines.push(
      colorSpan(
        `$(warning) Deprecated: ${escapeHtml(status.deprecation)}`,
        themeColorVariable("deprecated"),
      ),
    );
  }

  lines.push(...vulnerabilityLines(status.vulnerabilities));
  lines.push(...conflictLines(status.conflicts, name, latest));

  const description = cleanDescription(status.metadata?.description);
  if (description !== undefined) {
    lines.push(description);
  }

  lines.push(buildLinks(status, downloads));

  const markdown = new MarkdownString(lines.join("\n\n"));
  markdown.supportThemeIcons = true;
  markdown.supportHtml = true;
  return markdown;
}

/**
 * Renders each advisory affecting the version in use, naming the version
 * that fixes it where the advisory says so — the single most actionable
 * detail a security warning can carry.
 * @param vulnerabilities - The advisories to render.
 * @returns One markdown line per advisory, or an empty array if there are none.
 */
function vulnerabilityLines(vulnerabilities: Vulnerability[]): string[] {
  return vulnerabilities.map((vulnerability) => {
    const parts = [
      htmlLink(vulnerability.url, escapeHtml(vulnerability.id)),
      escapeHtml(vulnerability.summary ?? "Security advisory"),
    ];
    if (vulnerability.severity !== undefined) {
      parts.push(escapeHtml(vulnerability.severity.toLowerCase()));
    }
    if (vulnerability.fixedVersion !== undefined) {
      parts.push(`fixed in ${escapeHtml(vulnerability.fixedVersion)}`);
    }

    return colorSpan(
      `$(shield) ${parts.join(" · ")}`,
      themeColorVariable("vulnerable"),
    );
  });
}

/**
 * Renders each peer requirement blocking an upgrade, distinguishing the ones
 * a coordinated upgrade would clear from the ones that need upstream to
 * publish first.
 * @param conflicts - The blocking requirements.
 * @param packageName - The package whose upgrade is blocked.
 * @param latestVersion - The version being upgraded to, if known.
 * @returns One markdown line per conflict, or an empty array if there are none.
 */
function conflictLines(
  conflicts: PeerConflict[],
  packageName: string,
  latestVersion: string | undefined,
): string[] {
  const color = themeColorVariable("blocked");

  return conflicts.map((conflict) => {
    const requirement = `\`${conflict.blockedBy}@${conflict.blockerVersion}\` needs \`${packageName}@${conflict.requiredRange}\``;
    const remedy = conflict.resolvedByUpgradingBlocker
      ? `upgrading \`${conflict.blockedBy}\` too would allow \`${latestVersion ?? "the update"}\``
      : `its latest release still doesn't allow \`${latestVersion ?? "the update"}\``;

    return colorSpan(`$(circle-slash) ${requirement} — ${remedy}`, color);
  });
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
 * @param status - The dependency to link out from.
 * @param downloads - The formatted monthly download count, if known.
 * @returns An HTML line of `·`-separated links and stats.
 */
function buildLinks(
  status: DependencyStatus,
  downloads: string | undefined,
): string {
  const { metadata, entry } = status;
  const links: string[] = [];

  if (entry.source === "npm") {
    links.push(
      htmlLink(
        `https://www.npmjs.com/package/${encodeURIComponent(entry.name)}`,
        "npm",
      ),
    );
  }

  if (metadata?.repositoryUrl !== undefined) {
    links.push(htmlLink(metadata.repositoryUrl, "Repository"));
  }

  if (
    metadata?.homepage !== undefined &&
    metadata.homepage !== metadata.repositoryUrl
  ) {
    links.push(htmlLink(metadata.homepage, "Website"));
  }

  if (downloads !== undefined) {
    links.push(mutedSpan(`${downloads} downloads/mo`));
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
 * Escapes text that came from the registry — descriptions, deprecation
 * notices, advisory summaries — before it lands in an HTML-enabled hover.
 * @param text - The untrusted text.
 * @returns The text with HTML-significant characters escaped.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
 * complete badge, otherwise it can misfire on the last complete badge in
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
 *
 * Exported for testing; not part of the extension's public API.
 * @param description - The raw description text, if any.
 * @returns The cleaned description, or `undefined` if empty or blank once cleaned.
 */
export function cleanDescription(description?: string): string | undefined {
  if (description === undefined) {
    return undefined;
  }

  const cleaned = description
    .replace(LINKED_IMAGE_REGEX, "")
    .replace(IMAGE_REGEX, "")
    .replace(DANGLING_BADGE_TAIL_REGEX, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  return cleaned === "" ? undefined : cleaned;
}
