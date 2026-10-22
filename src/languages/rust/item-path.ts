/**
 * Pure helpers for naming Rust items. Kept free of the parser so evidence URI
 * validation does not load WebAssembly.
 */

/**
 * Maximum accepted length of one item path.
 */
const MAX_ITEM_PATH_LENGTH = 256;

/**
 * Canonicalizes a model- or human-written item path.
 *
 * Whitespace is insignificant except the single spaces around `as` inside a
 * qualified `<Type as Trait>` segment, so `< Ledger as  Display > :: fmt`
 * and `<Ledger as Display>::fmt` name the same item.
 *
 * @param itemPath - Candidate item path.
 * @returns Canonical item path, or `null` when the path is not well formed.
 */
export function canonicalizeRustItemPath(itemPath: string): string | null {
  const canonical = stripRawIdentifierPrefixes(canonicalizeTypeText(itemPath));
  if (
    canonical.length === 0 ||
    canonical.length > MAX_ITEM_PATH_LENGTH ||
    canonical.startsWith("::") ||
    canonical.endsWith("::") ||
    canonical.includes("::::") ||
    [...canonical].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return character === "#" || codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    return null;
  }
  return canonical;
}

/**
 * Whether a repository path names Rust source eligible for item anchors.
 *
 * @param filePath - Repository-relative path.
 * @returns Whether the file has a `.rs` extension.
 */
export function isRustSourcePath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".rs");
}

/**
 * Normalizes whitespace in type or path text.
 *
 * @param text - Raw type or path text.
 * @returns Text with whitespace removed around punctuation and collapsed elsewhere.
 */
export function canonicalizeTypeText(text: string): string {
  return text
    .replace(/\s+/gu, " ")
    .replace(/\s*(::|<|>|,|&|\(|\)|\[|\]|;|!|\.)\s*/gu, "$1")
    .trim();
}

/**
 * Removes raw-identifier prefixes, so `r#async` is addressed as `async`.
 * Rust treats both spellings as the same identifier, and `#` cannot appear in
 * an evidence fragment.
 *
 * @param text - Item path or path segment.
 * @returns Text without `r#` identifier prefixes.
 */
export function stripRawIdentifierPrefixes(text: string): string {
  return text.replace(/(^|[^A-Za-z0-9_])r#(?=[A-Za-z_])/gu, "$1");
}
