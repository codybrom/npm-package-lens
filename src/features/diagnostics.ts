import {
  Diagnostic,
  DiagnosticSeverity,
  DiagnosticTag,
  Disposable,
  languages,
  Uri,
  type DiagnosticCollection,
  type TextDocument,
} from "vscode";
import type { DependencyAnalyzer } from "../analysis/analyzer";
import { getSettings } from "../config";
import type { DependencyStatus, Vulnerability } from "../types";
import { isManifest, toRange } from "./manifest-documents";

/** Shown as the diagnostic's source, so the Problems panel attributes it. */
const DIAGNOSTIC_SOURCE = "npm Package Lens";

/**
 * Reports known advisories and publisher deprecations as editor diagnostics,
 * so an affected dependency is underlined in the manifest and listed in the
 * Problems panel rather than only being visible on hover.
 */
export class DependencyDiagnostics implements Disposable {
  private readonly collection: DiagnosticCollection =
    languages.createDiagnosticCollection("npmPackageLens");

  /**
   * @param analyzer - The analyzer supplying dependency statuses.
   */
  constructor(private readonly analyzer: DependencyAnalyzer) {}

  /**
   * Replaces the diagnostics for one manifest.
   * @param document - The manifest to report on.
   */
  refresh(document: TextDocument): void {
    if (!isManifest(document)) {
      return;
    }

    const settings = getSettings(document.uri);
    const analysis = this.analyzer.get(document.uri);

    if (
      !settings.checkVulnerabilities ||
      analysis?.documentVersion !== document.version
    ) {
      this.collection.delete(document.uri);
      return;
    }

    const diagnostics = analysis.statuses.flatMap((status) =>
      diagnosticsFor(document, status),
    );
    this.collection.set(document.uri, diagnostics);
  }

  /**
   * Drops the diagnostics for a manifest, e.g. once its document closes.
   * @param document - The manifest to stop reporting on.
   */
  clear(document: TextDocument): void {
    this.collection.delete(document.uri);
  }

  /** @inheritdoc */
  dispose(): void {
    this.collection.dispose();
  }
}

/**
 * Builds the diagnostics for one dependency: one per advisory, plus one for a
 * deprecation notice.
 * @param document - The manifest being reported on.
 * @param status - The analyzed dependency.
 * @returns The diagnostics, anchored to the declared specifier.
 */
function diagnosticsFor(
  document: TextDocument,
  status: DependencyStatus,
): Diagnostic[] {
  const range = toRange(document, status.entry.specifierRange);

  const advisories = status.vulnerabilities.map((vulnerability) => {
    const diagnostic = new Diagnostic(
      range,
      describeVulnerability(status, vulnerability),
      DiagnosticSeverity.Error,
    );
    diagnostic.source = DIAGNOSTIC_SOURCE;
    diagnostic.code = {
      value: vulnerability.id,
      target: Uri.parse(vulnerability.url),
    };
    return diagnostic;
  });

  if (status.deprecation === undefined) {
    return advisories;
  }

  const deprecation = new Diagnostic(
    range,
    `${status.entry.name} is deprecated: ${status.deprecation}`,
    DiagnosticSeverity.Warning,
  );
  deprecation.source = DIAGNOSTIC_SOURCE;
  deprecation.tags = [DiagnosticTag.Deprecated];

  return [...advisories, deprecation];
}

/**
 * Phrases one advisory as a diagnostic message, naming the affected version
 * and the fix where the advisory identifies one.
 * @param status - The analyzed dependency.
 * @param vulnerability - The advisory to describe.
 * @returns The diagnostic message.
 */
function describeVulnerability(
  status: DependencyStatus,
  vulnerability: Vulnerability,
): string {
  const affected =
    status.installedVersion ??
    status.resolvedSpecifier ??
    status.entry.specifier;
  const severity =
    vulnerability.severity === undefined
      ? ""
      : ` (${vulnerability.severity.toLowerCase()})`;
  const fix =
    vulnerability.fixedVersion === undefined
      ? ""
      : ` Fixed in ${vulnerability.fixedVersion}.`;

  return `${status.entry.name}@${affected}${severity}: ${vulnerability.summary ?? vulnerability.id}.${fix}`;
}
