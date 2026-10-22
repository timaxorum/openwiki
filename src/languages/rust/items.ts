import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { Node, Parser } from "web-tree-sitter";
import {
  canonicalizeTypeText,
  stripRawIdentifierPrefixes,
} from "./item-path.js";

/**
 * Version prefix for item-anchored Rust evidence.
 *
 * Bump the trailing version when item naming or hashing semantics change so
 * persisted Claims are rechecked instead of silently compared across schemes.
 */
export const RUST_ITEM_VERSION_PREFIX = "rust-item:v1:sha256:";

/**
 * One named item defined in a Rust source file.
 */
export interface RustItem {
  /**
   * File-relative item path, such as `Ledger::post` or `<Ledger as Display>::fmt`.
   */
  path: string;

  /**
   * Tree-sitter node kind, such as `function_item` or `impl_item`.
   */
  kind: string;

  /**
   * One-based first line, including leading doc comments and attributes.
   */
  startLine: number;

  /**
   * One-based last line.
   */
  endLine: number;

  /**
   * Exact source text, including leading doc comments and attributes.
   */
  text: string;

  /**
   * Syntax-token sequence of {@link text}. Whitespace, trailing commas, and
   * the text of ordinary `//` and block comments are not tokens, so
   * reformatting (for example by rustfmt) and comment rewording leave it
   * unchanged. Every other edit changes it, including edits to literals,
   * attributes, and doc comments, which document behavior.
   */
  fingerprint: string;
}

/**
 * Current resolution of one item path.
 */
export interface ResolvedRustItem {
  /**
   * Every definition sharing the path, in source order. Definitions are
   * duplicated legitimately by `#[cfg]` variants, so all are cited together.
   */
  items: RustItem[];

  /**
   * Exact cited source text for every matching definition.
   */
  content: string;

  /**
   * Formatting-insensitive version token for the cited definitions.
   */
  version: string;
}

/**
 * Comment delimiter tokens. Ordinary comment text is not a token, so skipping
 * the delimiters too makes adding or removing a plain comment a no-op, while
 * doc comments keep their marker and text tokens.
 */
const COMMENT_DELIMITERS = new Set(["//", "/*", "*/"]);

/**
 * Delimiters after which a trailing comma carries no meaning.
 */
const CLOSING_DELIMITERS = new Set([")", "]", "}", ">", "|"]);

/**
 * Number of parsed files kept in memory. Claims preflight resolves each cited
 * item separately, so files with many cited items would otherwise be parsed
 * once per citation.
 */
const PARSED_ITEMS_CACHE_SIZE = 16;

/**
 * Recently parsed item lists keyed by a hash of the complete source.
 */
const parsedItemsCache = new Map<string, RustItem[]>();

/**
 * Per-parse state shared while collecting items.
 */
interface ParseContext {
  /**
   * Complete source text.
   */
  source: string;

  /**
   * Start and end offsets of every non-empty leaf token, in source order.
   */
  leaves: { starts: number[]; ends: number[] };
}

let parserPromise: Promise<Parser> | undefined;

/**
 * Lazily loads the Rust grammar. The grammar ships as prebuilt WebAssembly, so
 * parsing never compiles or executes repository code.
 *
 * @returns Shared parser configured for Rust.
 */
async function getRustParser(): Promise<Parser> {
  parserPromise ??= (async () => {
    const require = createRequire(import.meta.url);
    const { Language, Parser } = await import("web-tree-sitter");
    await Parser.init();
    const language = await Language.load(
      require.resolve("tree-sitter-rust/tree-sitter-rust.wasm"),
    );
    const parser = new Parser();
    parser.setLanguage(language);
    return parser;
  })();
  return parserPromise;
}

/**
 * Lists every addressable item in a Rust source file.
 *
 * Addressable items are module-level and nested-module definitions, members of
 * `impl` and `trait` blocks, enum variants (`Error::NotFound`), and named
 * struct fields (`Ledger.total`). Items
 * declared inside function bodies are deliberately not addressable.
 *
 * @param source - Complete Rust source text.
 * @returns Items in source order.
 */
export async function listRustItems(source: string): Promise<RustItem[]> {
  const key = createHash("sha256").update(source).digest("hex");
  const cached = parsedItemsCache.get(key);
  if (cached) {
    parsedItemsCache.delete(key);
    parsedItemsCache.set(key, cached);
    return cached;
  }

  const parser = await getRustParser();
  const tree = parser.parse(source);
  if (!tree) {
    return [];
  }
  let items: RustItem[];
  try {
    const context: ParseContext = {
      source,
      leaves: collectLeaves(tree.rootNode),
    };
    items = [];
    collectItems(tree.rootNode, [], context, items);
  } finally {
    tree.delete();
  }

  parsedItemsCache.set(key, items);
  if (parsedItemsCache.size > PARSED_ITEMS_CACHE_SIZE) {
    const oldest = parsedItemsCache.keys().next().value;
    if (oldest !== undefined) {
      parsedItemsCache.delete(oldest);
    }
  }
  return items;
}

/**
 * Resolves one item path in a Rust source file.
 *
 * @param source - Complete Rust source text.
 * @param itemPath - Canonical item path.
 * @returns Every matching definition, or `null` when the item no longer exists.
 */
export async function resolveRustItem(
  source: string,
  itemPath: string,
): Promise<ResolvedRustItem | null> {
  const items = (await listRustItems(source)).filter(
    (item) => item.path === itemPath,
  );
  if (items.length === 0) {
    return null;
  }
  const content = items.map((item) => item.text).join("\n");
  const normalized = items.map((item) => item.fingerprint).join("\n");
  return {
    items,
    content,
    version: `${RUST_ITEM_VERSION_PREFIX}${createHash("sha256")
      .update(normalized)
      .digest("hex")}`,
  };
}

/**
 * Walks container nodes, recording addressable items.
 *
 * @param container - Source file, module body, or declaration list.
 * @param prefix - Item path segments of the enclosing scope.
 * @param context - Source text and leaf tokens of the parse.
 * @param items - Output accumulator.
 */
function collectItems(
  container: Node,
  prefix: string[],
  context: ParseContext,
  items: RustItem[],
): void {
  for (const node of namedChildrenOf(container)) {
    switch (node.type) {
      case "function_item":
      case "function_signature_item":
      case "struct_item":
      case "union_item":
      case "type_item":
      case "const_item":
      case "static_item":
      case "associated_type":
      case "macro_definition": {
        const name = node.childForFieldName("name")?.text;
        if (name && name !== "_") {
          pushItem(items, context, node, [...prefix, name]);
          if (node.type === "struct_item" || node.type === "union_item") {
            collectFields(node, [...prefix, name], context, items);
          }
        }
        break;
      }
      case "enum_item": {
        const name = node.childForFieldName("name")?.text;
        if (name) {
          pushItem(items, context, node, [...prefix, name]);
          const body = node.childForFieldName("body");
          for (const variant of body ? namedChildrenOf(body) : []) {
            const variantName =
              variant.type === "enum_variant"
                ? variant.childForFieldName("name")?.text
                : undefined;
            if (variantName) {
              pushItem(items, context, variant, [...prefix, name, variantName]);
            }
          }
        }
        break;
      }
      case "mod_item": {
        const name = node.childForFieldName("name")?.text;
        if (name) {
          pushItem(items, context, node, [...prefix, name]);
          const body = node.childForFieldName("body");
          if (body) {
            collectItems(body, [...prefix, name], context, items);
          }
        }
        break;
      }
      case "trait_item": {
        const name = node.childForFieldName("name")?.text;
        if (name) {
          pushItem(items, context, node, [...prefix, name]);
          const body = node.childForFieldName("body");
          if (body) {
            collectItems(body, [...prefix, name], context, items);
          }
        }
        break;
      }
      case "impl_item": {
        const segment = implSegment(node);
        if (segment) {
          const isTraitImpl = segment.startsWith("<");
          pushItem(
            items,
            context,
            node,
            isTraitImpl ? [...prefix, segment] : [...prefix, `impl ${segment}`],
          );
          const body = node.childForFieldName("body");
          if (body) {
            collectItems(body, [...prefix, segment], context, items);
          }
        }
        break;
      }
      default:
        break;
    }
  }
}

/**
 * Records named struct or union fields as `Type.field`. Fields use `.` rather
 * than `::` because getters commonly share their field's name.
 *
 * @param node - Struct or union definition.
 * @param typePath - Item path of the type.
 * @param context - Source text and leaf tokens of the parse.
 * @param items - Output accumulator.
 */
function collectFields(
  node: Node,
  typePath: string[],
  context: ParseContext,
  items: RustItem[],
): void {
  const body = node.childForFieldName("body");
  if (body?.type !== "field_declaration_list") {
    return;
  }
  for (const field of namedChildrenOf(body)) {
    const fieldName =
      field.type === "field_declaration"
        ? field.childForFieldName("name")?.text
        : undefined;
    if (fieldName) {
      pushItem(items, context, field, [
        ...typePath.slice(0, -1),
        `${typePath[typePath.length - 1]}.${fieldName}`,
      ]);
    }
  }
}

/**
 * Computes the path segment for an `impl` block.
 *
 * Inherent impls use the bare self type (`Ledger`); trait impls use Rust's
 * qualified-path syntax (`<Ledger as Display>`). Generic parameters on the
 * self type are dropped so `impl<T> Ledger<T>` stays `Ledger`, while trait
 * arguments are kept so `From<u8>` and `From<u16>` impls stay distinct.
 *
 * @param node - `impl` item.
 * @returns Path segment, or `undefined` when the self type is missing.
 */
function implSegment(node: Node): string | undefined {
  const selfType = node.childForFieldName("type");
  if (!selfType) {
    return undefined;
  }
  const typeName = baseTypeName(selfType);
  const trait = node.childForFieldName("trait");
  if (!trait) {
    return typeName;
  }
  const negative = node.children.some((child) => child?.type === "!");
  return canonicalizeTypeText(
    `<${typeName} as ${negative ? "!" : ""}${traitName(trait)}>`,
  );
}

/**
 * Reduces a self type to its last path segment without generics or references.
 *
 * @param node - Type node.
 * @returns Canonical type name.
 */
function baseTypeName(node: Node): string {
  switch (node.type) {
    case "type_identifier":
    case "primitive_type":
      return node.text;
    case "generic_type": {
      const inner = node.childForFieldName("type");
      return inner ? baseTypeName(inner) : canonicalizeTypeText(node.text);
    }
    case "scoped_type_identifier": {
      const name = node.childForFieldName("name");
      return name ? name.text : canonicalizeTypeText(node.text);
    }
    case "reference_type":
    case "pointer_type": {
      const inner = node.childForFieldName("type");
      return inner ? baseTypeName(inner) : canonicalizeTypeText(node.text);
    }
    default:
      return canonicalizeTypeText(node.text);
  }
}

/**
 * Reduces a trait reference to its last path segment, keeping type arguments.
 *
 * @param node - Trait node of an `impl`.
 * @returns Canonical trait name.
 */
function traitName(node: Node): string {
  if (node.type === "scoped_type_identifier") {
    return (
      node.childForFieldName("name")?.text ?? canonicalizeTypeText(node.text)
    );
  }
  if (node.type === "generic_type") {
    const inner = node.childForFieldName("type");
    const args = node.childForFieldName("type_arguments");
    const base = inner ? traitName(inner) : "";
    return canonicalizeTypeText(`${base}${args?.text ?? ""}`);
  }
  return canonicalizeTypeText(node.text);
}

/**
 * Adds one item, extending its span over leading doc comments and attributes.
 *
 * @param items - Output accumulator.
 * @param context - Source text and leaf tokens of the parse.
 * @param node - Item node.
 * @param segments - Item path segments.
 */
function pushItem(
  items: RustItem[],
  context: ParseContext,
  node: Node,
  segments: string[],
): void {
  let first = node;
  let previous = node.previousNamedSibling;
  while (previous && isLeadingDecoration(previous, first)) {
    first = previous;
    previous = previous.previousNamedSibling;
  }
  const { source, leaves } = context;
  const text = source.slice(first.startIndex, node.endIndex);
  const tokens: string[] = [];
  for (
    let index = lowerBound(leaves.starts, first.startIndex);
    index < leaves.starts.length && leaves.ends[index] <= node.endIndex;
    index += 1
  ) {
    tokens.push(source.slice(leaves.starts[index], leaves.ends[index]));
  }
  items.push({
    path: stripRawIdentifierPrefixes(segments.join("::")),
    kind: node.type,
    startLine: first.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    text,
    fingerprint: tokens
      .filter(
        (token, index) =>
          token !== "," || !CLOSING_DELIMITERS.has(tokens[index + 1] ?? ""),
      )
      .join("\u0000"),
  });
}

/**
 * Records the offsets of every non-empty leaf token in one cursor walk,
 * skipping comment delimiters.
 *
 * @param root - Tree root.
 * @returns Leaf start and end offsets in source order.
 */
function collectLeaves(root: Node): { starts: number[]; ends: number[] } {
  const starts: number[] = [];
  const ends: number[] = [];
  const cursor = root.walk();
  try {
    for (;;) {
      if (cursor.gotoFirstChild()) {
        continue;
      }
      if (
        cursor.endIndex > cursor.startIndex &&
        !COMMENT_DELIMITERS.has(cursor.nodeType)
      ) {
        starts.push(cursor.startIndex);
        ends.push(cursor.endIndex);
      }
      while (!cursor.gotoNextSibling()) {
        if (!cursor.gotoParent()) {
          return { starts, ends };
        }
      }
    }
  } finally {
    cursor.delete();
  }
}

/**
 * Finds the first index whose value is at least the target.
 *
 * @param values - Ascending values.
 * @param target - Value to locate.
 * @returns Insertion index.
 */
function lowerBound(values: number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] < target) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/**
 * Whether a sibling is an outer doc comment or attribute attached to the next node.
 *
 * @param candidate - Preceding sibling.
 * @param next - Node it would attach to.
 * @returns Whether it decorates `next` with no blank line in between.
 */
function isLeadingDecoration(candidate: Node, next: Node): boolean {
  if (next.startPosition.row - candidate.endPosition.row > 1) {
    return false;
  }
  if (candidate.type === "attribute_item") {
    return true;
  }
  if (candidate.type === "line_comment" || candidate.type === "block_comment") {
    return /^(\/\/\/[^/]|\/\/\/$|\/\*\*[^*])/u.test(candidate.text);
  }
  return false;
}

/**
 * Returns a node's named children without the binding's nullable slots.
 *
 * @param node - Parent node.
 * @returns Named children in source order.
 */
function namedChildrenOf(node: Node): Node[] {
  return node.namedChildren.filter((child): child is Node => child !== null);
}
