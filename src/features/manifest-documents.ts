import { languages, Range, type TextDocument } from "vscode";
import { getSettings } from "../config";
import type { OffsetRange } from "../parse/package-document";

/**
 * Checks whether a document is an npm manifest this extension annotates.
 *
 * Matching is by path glob rather than filename so the `files` setting can
 * widen coverage to a monorepo's nested manifests or narrow it to one
 * directory, and the language check keeps the extension out of documents
 * VS Code isn't parsing as JSON at all.
 * @param document - The document to check.
 * @returns `true` if the document should be annotated.
 */
export function isManifest(document: TextDocument): boolean {
  if (!["json", "jsonc"].includes(document.languageId)) {
    return false;
  }

  const { files } = getSettings(document.uri);
  return languages.match({ pattern: files, scheme: "file" }, document) > 0;
}

/**
 * Converts a parser offset span into an editor range.
 * @param document - The document the offsets index into.
 * @param span - The offset span to convert.
 * @returns The equivalent range.
 */
export function toRange(document: TextDocument, span: OffsetRange): Range {
  return new Range(
    document.positionAt(span.start),
    document.positionAt(span.end),
  );
}

/**
 * Builds the zero-width range at the end of the line containing `offset`,
 * where end-of-line annotations are anchored.
 * @param document - The document to measure.
 * @param offset - Any offset on the target line.
 * @returns A zero-width range at that line's end.
 */
export function endOfLineRange(document: TextDocument, offset: number): Range {
  const line = document.lineAt(document.positionAt(offset).line);
  return new Range(line.range.end, line.range.end);
}
