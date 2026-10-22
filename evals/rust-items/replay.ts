/**
 * Replays a Rust repository's history to compare line-range and item evidence.
 *
 * For every commit that modifies `.rs` files, each function and type defined
 * in a modified file at the parent commit is cited twice: once as a line range
 * covering exactly the item (the best case for line ranges) and once as item
 * evidence. Both citations are then re-resolved at the child commit with their
 * prior versions, exactly as Claims preflight does, and compared with what
 * actually happened to the item's text.
 *
 * Usage: pnpm exec tsx evals/rust-items/replay.ts <repo> [commits=300]
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RepositoryEvidenceResolver } from "../../src/claims/evidence/repository/resolver.ts";
import {
  listRustItems,
  type RustItem,
} from "../../src/languages/rust/items.ts";

/**
 * Item kinds cited by the replay. Impl blocks, modules, fields, and variants
 * are skipped because they overlap the functions and types they contain.
 */
const CITED_KINDS = new Set([
  "function_item",
  "struct_item",
  "enum_item",
  "trait_item",
  "type_item",
  "const_item",
  "static_item",
  "macro_definition",
]);

/**
 * What actually happened to an item between parent and child.
 */
type Truth = "unchanged" | "formatting-or-comments-only" | "edited" | "removed";

/**
 * How Claims preflight would classify a citation.
 */
type Verdict = "current" | "stale" | "unresolved";

interface Tally {
  [truth: string]: Record<Verdict, number>;
}

async function main(): Promise<void> {
  const repo = process.argv[2];
  const commitLimit = Number(process.argv[3] ?? 300);
  if (!repo) {
    throw new Error("Usage: replay.ts <repo> [commits]");
  }
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });

  const commits = git(
    "log",
    "--no-merges",
    "--format=%H %P",
    `-n${commitLimit}`,
    "--",
    "*.rs",
  )
    .trim()
    .split("\n")
    .map((line) => line.split(" "))
    .filter((parts) => parts.length === 2);

  const root = await mkdtemp(path.join(tmpdir(), "openwiki-rust-replay-"));
  const resolver = new RepositoryEvidenceResolver({ rootDir: root });
  const line: Tally = {};
  const item: Tally = {};
  let lineWrongContent = 0;
  const uncitable: string[] = [];
  let citations = 0;
  let files = 0;
  let itemMillis = 0;

  const record = (tally: Tally, truth: Truth, verdict: Verdict) => {
    tally[truth] ??= { current: 0, stale: 0, unresolved: 0 };
    tally[truth][verdict] += 1;
  };

  try {
    for (const [child, parent] of commits) {
      const changed = git(
        "diff",
        "--name-only",
        "--diff-filter=M",
        parent,
        child,
        "--",
        "*.rs",
      )
        .trim()
        .split("\n")
        .filter(Boolean);
      for (const file of changed) {
        let before: string;
        let after: string;
        try {
          before = git("show", `${parent}:${file}`);
          after = git("show", `${child}:${file}`);
        } catch {
          continue;
        }
        files += 1;
        const beforeItems = (await listRustItems(before)).filter((candidate) =>
          CITED_KINDS.has(candidate.kind),
        );
        const afterItems = await listRustItems(after);
        const absolute = path.join(root, file);
        await mkdir(path.dirname(absolute), { recursive: true });

        await writeFile(absolute, before, "utf8");
        const established: {
          cited: RustItem;
          lineResource: string;
          lineVersion: string;
          itemResource: string;
          itemVersion: string;
        }[] = [];
        for (const cited of beforeItems) {
          if (
            beforeItems.filter((other) => other.path === cited.path).length > 1
          ) {
            continue;
          }
          let lineEvidence;
          let itemEvidence;
          try {
            lineEvidence = await resolver.resolve(
              `repo://${file}#L${cited.startLine}-L${cited.endLine}`,
            );
            itemEvidence = await resolver.resolve(
              `repo://${file}#item=${encodeURIComponent(cited.path)}`,
            );
          } catch (error) {
            uncitable.push(
              `${file}#${cited.path}: ${error instanceof Error ? error.message : String(error)}`,
            );
            continue;
          }
          if (!lineEvidence || !itemEvidence) {
            uncitable.push(`${file}#${cited.path}: did not resolve when cited`);
            continue;
          }
          established.push({
            cited,
            lineResource: lineEvidence.evidence.resource,
            lineVersion: lineEvidence.evidence.version,
            itemResource: itemEvidence.evidence.resource,
            itemVersion: itemEvidence.evidence.version,
          });
        }

        await writeFile(absolute, after, "utf8");
        for (const entry of established) {
          citations += 1;
          const successor = afterItems.filter(
            (candidate) => candidate.path === entry.cited.path,
          );
          const truth: Truth =
            successor.length !== 1
              ? "removed"
              : dedent(successor[0].text) === dedent(entry.cited.text)
                ? "unchanged"
                : squash(successor[0].text) === squash(entry.cited.text)
                  ? "formatting-or-comments-only"
                  : "edited";

          const lineNow = await resolver.resolve(
            entry.lineResource,
            entry.lineVersion,
          );
          const lineVerdict: Verdict = !lineNow
            ? "unresolved"
            : lineNow.evidence.version === entry.lineVersion
              ? "current"
              : "stale";
          record(line, truth, lineVerdict);
          if (
            lineNow &&
            lineVerdict === "current" &&
            successor.length === 1 &&
            dedent(lineNow.content) !== dedent(successor[0].text)
          ) {
            lineWrongContent += 1;
          }

          const started = performance.now();
          const itemNow = await resolver.resolve(
            entry.itemResource,
            entry.itemVersion,
          );
          itemMillis += performance.now() - started;
          record(
            item,
            truth,
            !itemNow
              ? "unresolved"
              : itemNow.evidence.version === entry.itemVersion
                ? "current"
                : "stale",
          );
        }
        await rm(absolute, { force: true });
      }
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }

  console.log(
    JSON.stringify(
      {
        repo: path.basename(path.resolve(repo)),
        commits: commits.length,
        modifiedFiles: files,
        citations,
        lineRange: line,
        item,
        lineRangeCitingOtherCode: lineWrongContent,
        uncitableItems: uncitable.length,
        uncitableExamples: uncitable.slice(0, 5),
        itemResolveMillisPerCitation: Number(
          (itemMillis / Math.max(citations, 1)).toFixed(2),
        ),
      },
      null,
      2,
    ),
  );
}

/**
 * Removes common leading indentation so re-indentation alone is not an edit.
 */
function dedent(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trimStart())
    .join("\n")
    .trimEnd();
}

/**
 * Removes whitespace, trailing commas, and ordinary (non-doc) line comments
 * for the formatting-or-comments-only check. Deliberately simpler than the
 * tokenizer it audits: it does not parse strings, so it can only misclassify
 * toward "edited".
 */
function squash(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^(\s*)\/\/(?![/!]).*$/u, "$1"))
    .join("\n")
    .replace(/,(\s*[)\]}>|])/gu, "$1")
    .replace(/\s+/gu, "");
}

await main();
