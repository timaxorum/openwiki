import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import type { OpenWikiIgnore } from "../../agent/openwiki-ignore.js";
import { parseRepositoryEvidenceResource } from "../../claims/evidence/repository/resource.js";
import { isRustSourcePath } from "./item-path.js";
import { listRustItems } from "./items.js";
import {
  isRustRepository,
  readRustWorkspace,
  renderRustWorkspace,
} from "./workspace.js";

export { isRustRepository } from "./workspace.js";

/**
 * Maximum items returned by one `list_rust_items` call.
 */
const MAX_LISTED_ITEMS = 400;

/**
 * Planner guidance appended after the computed crate map.
 */
const RUST_PLANNER_GUIDANCE = `Rust planning guidance:
- Treat crates as the primary ownership boundaries and the layers above as the dependency direction. Group pages by crate or by a cross-crate workflow, not by file.
- Start seedPaths from each crate's Cargo.toml and lib/bin entrypoints listed above instead of rediscovering them.
- Give explicit coverage to build scripts, proc-macro crates, and feature flags that change compiled behavior when they are present; they are easy to miss from source browsing alone.`;

/**
 * Page-worker guidance for Rust repositories.
 */
export const RUST_PAGE_GUIDANCE = `Rust repository guidance:
- Prefer item evidence over line ranges for Rust source: repo://<path>.rs#item=<item path>. Item evidence stays current when unrelated code moves and becomes stale only when the cited item itself changes. Call list_rust_items on a file to get exact item paths before citing them.
- Item paths are relative to the file: \`Ledger\`, \`Ledger::post\` (inherent method), \`impl Ledger\` (all inherent impl blocks), \`<Ledger as Display>\` and \`<Ledger as Display>::fmt\` (trait impl and its method), \`Ledger.total\` (field), \`Error::NotFound\` (variant), \`store::open\` (item in an inline module). Use line ranges only for code inside a function body that matters on its own.
- Rust-specific substance worth documenting and claiming when the topic involves it: each \`unsafe\` block or impl and the invariant its SAFETY justification relies on; Send/Sync and lifetime constraints on shared state; error types and how they propagate (\`?\`, conversions via From); where code can panic; behavior that differs by feature flag or \`#[cfg]\`; which async runtime and blocking assumptions apply; and public API boundaries between crates.`;

/**
 * Builds the Rust context appended to the repository planner prompt.
 *
 * @param rootDir - Absolute repository root.
 * @param openWikiIgnore - Read-boundary rules.
 * @returns Planner context, or `undefined` for non-Rust repositories.
 */
export async function buildRustPlanningContext(
  rootDir: string,
  openWikiIgnore: OpenWikiIgnore,
): Promise<string | undefined> {
  if (!(await isRustRepository(rootDir))) {
    return undefined;
  }
  const workspace = await readRustWorkspace(rootDir, openWikiIgnore);
  if (!workspace || workspace.crates.length === 0) {
    return undefined;
  }
  return `${renderRustWorkspace(workspace)}\n\n${RUST_PLANNER_GUIDANCE}`;
}

/**
 * Creates the read-only `list_rust_items` worker tool.
 *
 * @param rootDir - Absolute repository root.
 * @param openWikiIgnore - Read-boundary rules shared with the agent.
 * @returns Tool listing addressable items and their line spans in one file.
 */
export function createListRustItemsTool(
  rootDir: string,
  openWikiIgnore: OpenWikiIgnore,
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: "list_rust_items",
    description:
      "List the addressable items in one Rust source file with their line spans, for citing evidence as repo://<path>.rs#item=<item path>. Read-only.",
    schema: z
      .object({
        path: z
          .string()
          .min(1)
          .describe("Repository-relative .rs path, such as src/lib.rs."),
      })
      .strict(),
    func: async ({ path: filePath }: { path: string }) => {
      try {
        const relative = await resolveReadableRustFile(
          rootDir,
          openWikiIgnore,
          filePath,
        );
        const items = await listRustItems(
          await readFile(path.join(rootDir, relative), "utf8"),
        );
        if (items.length === 0) {
          return `${relative}: no addressable items.`;
        }
        const shown = items.slice(0, MAX_LISTED_ITEMS);
        return [
          `${relative}: ${items.length} item(s). Cite as repo://${relative}#item=<item path>.`,
          ...shown.map(
            (item) =>
              `L${item.startLine}-L${item.endLine} ${item.kind.replace(/_item$|_definition$|_declaration$/u, "")} ${item.path}`,
          ),
          ...(items.length > shown.length
            ? [`... ${items.length - shown.length} more omitted.`]
            : []),
        ].join("\n");
      } catch (error) {
        return `list_rust_items failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });
}

/**
 * Validates a worker-supplied path with the same rules as repository evidence.
 *
 * @param rootDir - Absolute repository root.
 * @param openWikiIgnore - Read-boundary rules.
 * @param filePath - Repository-relative, virtual (`/src/lib.rs`), or `repo://` path.
 * @returns Normalized repository-relative path.
 */
async function resolveReadableRustFile(
  rootDir: string,
  openWikiIgnore: OpenWikiIgnore,
  filePath: string,
): Promise<string> {
  const withoutPrefix = filePath.startsWith("repo://")
    ? filePath.slice("repo://".length).split("#")[0]
    : filePath.replace(/^\/+/u, "");
  const { path: relative } = parseRepositoryEvidenceResource(
    `repo://${withoutPrefix}`,
  );
  if (!isRustSourcePath(relative)) {
    throw new Error(`${relative} is not a .rs file.`);
  }
  if (openWikiIgnore.ignores(relative)) {
    throw new Error(`${relative} is excluded by .openwikiignore.`);
  }
  const absolute = path.resolve(rootDir, relative);
  const metadata = await lstat(absolute);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${relative} is not a regular file.`);
  }
  const realRoot = await realpath(rootDir);
  if ((await realpath(absolute)) !== path.resolve(realRoot, relative)) {
    throw new Error(`${relative} traverses a symbolic link.`);
  }
  return relative;
}
