import { parseTree, type Node } from "jsonc-parser";
import {
  Range,
  workspace,
  WorkspaceEdit,
  type TextDocument,
  type Uri,
} from "vscode";
import type { OffsetRange } from "../parse/package-document";
import { toRange } from "./manifest-documents";

/** One specifier rewrite: which span to replace, and what to put there. */
export interface SpecifierEdit {
  /** The span of the specifier being rewritten, excluding its quotes. */
  span: OffsetRange;
  /** The new specifier text. */
  replacement: string;
}

/**
 * Manifests this extension has just saved itself.
 *
 * The custom install task fires on save, which is right for a save the user
 * made and wrong for one this extension made on their behalf — updating a
 * dependency shouldn't silently install when they asked for the update
 * without the install.
 */
const selfInitiatedSaves = new Set<string>();

/**
 * Reports whether the save that just happened was this extension's own, and
 * clears the mark so the next save is judged on its own terms.
 * @param uri - The manifest that was saved.
 * @returns `true` if this extension initiated the save.
 */
export function wasSelfInitiatedSave(uri: Uri): boolean {
  const key = uri.toString();
  const found = selfInitiatedSaves.has(key);
  selfInitiatedSaves.delete(key);
  return found;
}

/**
 * Applies specifier rewrites to a manifest in a single undoable edit, then
 * saves it.
 *
 * Saving is part of the operation rather than left to the user: an update
 * that sits unsaved is one the tooling around it — installs, the analyzer's
 * next pass, anything watching the file — can't see.
 *
 * Edits are applied against the document as it stands, so callers must pass
 * spans from an analysis of that same revision — the analyzer's
 * `documentVersion` is what makes that checkable.
 * @param document - The manifest to edit.
 * @param edits - The rewrites to apply; an empty list is a no-op.
 * @returns `true` if the edit was applied, `false` if VS Code rejected it.
 */
export async function applySpecifierEdits(
  document: TextDocument,
  edits: SpecifierEdit[],
): Promise<boolean> {
  if (edits.length === 0) {
    return true;
  }

  const workspaceEdit = new WorkspaceEdit();
  for (const edit of edits) {
    workspaceEdit.replace(
      document.uri,
      toRange(document, edit.span),
      edit.replacement,
    );
  }

  if (!(await workspace.applyEdit(workspaceEdit))) {
    return false;
  }

  if (document.isDirty) {
    selfInitiatedSaves.add(document.uri.toString());
    await document.save();
  }

  return true;
}

/**
 * Sorts the entries of each named dependency section alphabetically, leaving
 * the rest of the manifest untouched.
 *
 * Each entry keeps its own text verbatim — comments and formatting included
 * — and only the order changes. Entries are rejoined one per line at the
 * indentation of the section's first entry, which is how manifests are
 * written in practice; a section with several entries packed onto one line
 * would be reflowed.
 * @param document - The manifest to sort.
 * @param sectionPaths - Dotted paths of the sections to sort.
 * @returns `true` if the edit was applied (or nothing needed sorting).
 */
export async function sortDependencySections(
  document: TextDocument,
  sectionPaths: string[],
): Promise<boolean> {
  const root = parseTree(document.getText(), [], { allowTrailingComma: true });
  if (!root) {
    return true;
  }

  const workspaceEdit = new WorkspaceEdit();
  let changed = false;

  for (const path of sectionPaths) {
    const section = findNode(root, path.split("."));
    if (section?.type !== "object") {
      continue;
    }

    const sorted = sortSection(document, section);
    if (sorted) {
      workspaceEdit.replace(document.uri, sorted.range, sorted.text);
      changed = true;
    }
  }

  return changed ? workspace.applyEdit(workspaceEdit) : true;
}

/** A replacement covering one section's entries. */
interface SectionRewrite {
  /** The span from the first entry through the last. */
  range: Range;
  /** The entries, sorted and rejoined. */
  text: string;
}

/**
 * Builds the sorted replacement for one section's entries.
 * @param document - The manifest being sorted.
 * @param section - The section's object node.
 * @returns The rewrite, or `undefined` if the section is already sorted or too small to sort.
 */
function sortSection(
  document: TextDocument,
  section: Node,
): SectionRewrite | undefined {
  const properties = (section.children ?? []).filter(
    (child) => child.type === "property" && child.children?.length === 2,
  );
  if (properties.length < 2) {
    return undefined;
  }

  const first = properties[0];
  const last = properties[properties.length - 1];
  if (!first || !last) {
    return undefined;
  }

  const keyed = properties.map((property) => ({
    key: String(property.children?.[0]?.value ?? ""),
    text: document.getText(
      toRange(document, {
        start: property.offset,
        end: property.offset + property.length,
      }),
    ),
  }));

  const sorted = [...keyed].sort((a, b) => a.key.localeCompare(b.key));
  if (sorted.every((entry, index) => entry.key === keyed[index]?.key)) {
    return undefined;
  }

  const indent = indentOf(document, first.offset);
  return {
    range: new Range(
      document.positionAt(first.offset),
      document.positionAt(last.offset + last.length),
    ),
    text: sorted.map((entry) => entry.text).join(`,\n${indent}`),
  };
}

/**
 * Reads the leading whitespace of the line containing `offset`, so rejoined
 * entries keep the manifest's existing indentation.
 * @param document - The document to measure.
 * @param offset - An offset on the line to read.
 * @returns The line's leading whitespace.
 */
function indentOf(document: TextDocument, offset: number): string {
  const line = document.lineAt(document.positionAt(offset).line);
  return /^\s*/.exec(line.text)?.[0] ?? "";
}

/**
 * Walks a dotted property path from the document root.
 * @param root - The parsed root node.
 * @param path - The path segments to follow.
 * @returns The value node at that path, or `undefined` if the path doesn't exist.
 */
function findNode(root: Node, path: string[]): Node | undefined {
  let current: Node = root;

  for (const segment of path) {
    const value = current.children?.find(
      (child) =>
        child.type === "property" &&
        String(child.children?.[0]?.value) === segment,
    )?.children?.[1];

    if (!value) {
      return undefined;
    }
    current = value;
  }

  return current;
}
