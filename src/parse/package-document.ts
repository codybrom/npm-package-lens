import { type Node, parseTree } from "jsonc-parser";

/**
 * A half-open span of character offsets into the manifest text, which
 * callers convert into editor positions. Keeping the parser offset-based
 * rather than `Range`-based is what lets it run outside the extension host.
 */
export interface OffsetRange {
  /** Offset of the first character in the span. */
  start: number;
  /** Offset one past the last character in the span. */
  end: number;
}

/** Which registry a specifier's comparison version is resolved against. */
export type LookupSource = "npm" | "node";

/** A single declared dependency found in a manifest. */
export interface DependencyEntry {
  /** The package name being depended on. */
  name: string;
  /** The version specifier exactly as written, e.g. `^1.2.3`. */
  specifier: string;
  /** Dotted path of the property the entry was declared under, e.g. `devDependencies`. */
  section: string;
  /** Which registry resolves this entry's latest version. */
  source: LookupSource;
  /** Span of the package name, excluding its surrounding quotes. */
  nameRange: OffsetRange;
  /** Span of the specifier, excluding its surrounding quotes — the span an update rewrites. */
  specifierRange: OffsetRange;
}

/** A dependency map found in a manifest, for section-level summaries. */
export interface ManifestSection {
  /** Dotted path of the property, e.g. `dependencies` or `pnpm.overrides`. */
  path: string;
  /** Span of the property's key, excluding its surrounding quotes. */
  nameRange: OffsetRange;
  /** Span of the whole property, from its key through its closing brace. */
  fullRange: OffsetRange;
}

/** Everything the extension needs from one parsed manifest. */
export interface ParsedManifest {
  /** Every dependency entry found, in document order. */
  entries: DependencyEntry[];
  /** Every dependency map found, in document order. */
  sections: ManifestSection[];
}

/**
 * Tool names valid in `engines` and `packageManager` that resolve against
 * the npm registry rather than the Node.js release index.
 */
const PACKAGE_MANAGER_NAMES = new Set(["npm", "yarn", "pnpm", "bun"]);

/**
 * Parses a `package.json` into the dependency entries and sections the
 * extension annotates.
 *
 * Beyond the configured `dependencyProperties`, two well-known fields are
 * always parsed because they carry versions in shapes a dependency map
 * pattern can't describe: `engines` (whose `node` key resolves against the
 * Node.js release index rather than npm) and the top-level `packageManager`
 * string (`"pnpm@10.4.1"`), whose specifier span covers only the part after
 * the `@` so an update rewrites the version without losing the tool name.
 *
 * Malformed JSON yields whatever was parsable rather than throwing, since
 * manifests are routinely read mid-edit.
 * @param text - The full manifest text.
 * @param dependencyProperties - Dotted property paths to treat as dependency maps. A `*` segment matches any single property name.
 * @returns The entries and sections found.
 */
export function parseManifest(
  text: string,
  dependencyProperties: string[],
): ParsedManifest {
  const root = parseTree(text, [], { allowTrailingComma: true });
  const manifest: ParsedManifest = { entries: [], sections: [] };
  if (root?.type !== "object") {
    return manifest;
  }

  const matchers = dependencyProperties.map(toPathMatcher);

  for (const property of propertiesOf(root)) {
    collectFrom(property, [property.key], matchers, manifest);
  }

  return manifest;
}

/** A property node decomposed into the parts the walk needs. */
interface Property {
  /** The property name. */
  key: string;
  /** Span of the property name, excluding quotes. */
  keyRange: OffsetRange;
  /** The property's value node. */
  value: Node;
  /** Span of the whole `"key": value` pair. */
  fullRange: OffsetRange;
}

/**
 * Walks one property, recording it as a section (and its string children as
 * entries) when its path matches a configured dependency-map pattern, then
 * recursing so nested patterns like `overrides.*` are reached.
 * @param property - The property to inspect.
 * @param path - The property's dotted path, as path segments.
 * @param matchers - Compiled dependency-map path matchers.
 * @param manifest - The result being accumulated into.
 */
function collectFrom(
  property: Property,
  path: string[],
  matchers: PathMatcher[],
  manifest: ParsedManifest,
): void {
  if (path.length === 1) {
    if (property.key === "packageManager") {
      addPackageManagerEntry(property, manifest);
      return;
    }
    if (property.key === "engines") {
      addEngineEntries(property, manifest);
      return;
    }
  }

  if (property.value.type !== "object") {
    return;
  }

  const dottedPath = path.join(".");
  const children = propertiesOf(property.value);

  if (matchers.some((matches) => matches(path))) {
    manifest.sections.push({
      path: dottedPath,
      nameRange: property.keyRange,
      fullRange: property.fullRange,
    });

    for (const child of children) {
      if (child.value.type !== "string") {
        continue;
      }
      manifest.entries.push({
        // npm's nested-override syntax uses "." to mean "the package this
        // override block is keyed by", so the name comes from the parent.
        name: child.key === "." ? (path[path.length - 1] ?? ".") : child.key,
        specifier: String(child.value.value),
        section: dottedPath,
        source: "npm",
        nameRange: child.keyRange,
        specifierRange: innerStringRange(child.value),
      });
    }
  }

  for (const child of children) {
    collectFrom(child, [...path, child.key], matchers, manifest);
  }
}

/**
 * Records the `node` key of an `engines` block against the Node.js release
 * index, and any package-manager keys against the npm registry.
 * @param property - The `engines` property.
 * @param manifest - The result being accumulated into.
 */
function addEngineEntries(property: Property, manifest: ParsedManifest): void {
  if (property.value.type !== "object") {
    return;
  }

  for (const child of propertiesOf(property.value)) {
    if (child.value.type !== "string") {
      continue;
    }
    const isNode = child.key === "node";
    if (!isNode && !PACKAGE_MANAGER_NAMES.has(child.key)) {
      continue;
    }

    manifest.entries.push({
      name: child.key,
      specifier: String(child.value.value),
      section: "engines",
      source: isNode ? "node" : "npm",
      nameRange: child.keyRange,
      specifierRange: innerStringRange(child.value),
    });
  }
}

/**
 * Records the top-level `packageManager` field, whose value packs the tool
 * name and version into one string (`"pnpm@10.4.1"`, optionally followed by
 * a `+sha512-…` integrity hash).
 * @param property - The `packageManager` property.
 * @param manifest - The result being accumulated into.
 */
function addPackageManagerEntry(
  property: Property,
  manifest: ParsedManifest,
): void {
  if (property.value.type !== "string") {
    return;
  }

  const raw = String(property.value.value);
  const match = /^([^@]+)@([^+]+)/.exec(raw);
  const name = match?.[1];
  const version = match?.[2];
  if (!name || !version || !PACKAGE_MANAGER_NAMES.has(name)) {
    return;
  }

  const valueStart = innerStringRange(property.value).start;
  manifest.entries.push({
    name,
    specifier: version,
    section: "packageManager",
    source: "npm",
    nameRange: property.keyRange,
    specifierRange: {
      start: valueStart + name.length + 1,
      end: valueStart + name.length + 1 + version.length,
    },
  });
}

/** A predicate testing whether a property path is a configured dependency map. */
type PathMatcher = (path: string[]) => boolean;

/**
 * Compiles a dotted pattern into a path matcher. A `*` segment matches any
 * single property name; every other segment must match exactly.
 * @param pattern - The pattern, e.g. `overrides.*`.
 * @returns A predicate over path segments.
 */
function toPathMatcher(pattern: string): PathMatcher {
  const expected = pattern.split(".");
  return (path) =>
    path.length === expected.length &&
    expected.every(
      (segment, index) => segment === "*" || segment === path[index],
    );
}

/**
 * Extracts the object's properties as {@link Property} records, skipping any
 * malformed entry (a half-typed `"foo":` with no value, for instance).
 * @param objectNode - An object node.
 * @returns The well-formed properties, in document order.
 */
function propertiesOf(objectNode: Node): Property[] {
  const properties: Property[] = [];

  for (const child of objectNode.children ?? []) {
    const [keyNode, valueNode] = child.children ?? [];
    if (child.type !== "property" || !keyNode || !valueNode) {
      continue;
    }

    properties.push({
      key: String(keyNode.value),
      keyRange: innerStringRange(keyNode),
      value: valueNode,
      fullRange: { start: child.offset, end: child.offset + child.length },
    });
  }

  return properties;
}

/**
 * Returns the span of a string node's contents, excluding the surrounding
 * quotes, so replacing the span rewrites the value and leaves the quotes in
 * place.
 * @param stringNode - A string-valued node.
 * @returns The span between the quotes.
 */
function innerStringRange(stringNode: Node): OffsetRange {
  return {
    start: stringNode.offset + 1,
    end: stringNode.offset + stringNode.length - 1,
  };
}
