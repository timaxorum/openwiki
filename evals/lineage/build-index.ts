/**
 * Builds a lineage index for a Rust repository: every change to the default
 * branch and every unmerged pull-request attempt, each with the Rust items it
 * touched. The context assembler reads this index to answer "what happened to
 * these items before commit X".
 *
 * Usage:
 *   pnpm exec tsx evals/lineage/build-index.ts <repo> <out.json> [--branch main] [--min-pr N]
 *
 * Unmerged attempts come from `refs/remotes/pr/<N>` (fetch them first with
 * `git fetch origin '+refs/pull/*\/head:refs/remotes/pr/*'`). A PR counts as
 * merged when a default-branch commit subject ends with `(#N)`.
 */
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { listRustItems } from "../../src/languages/rust/items.ts";
import type { ItemChange, LineageEvent, LineageIndex } from "./types.ts";

const MAX_FILES_PER_EVENT = 200;

async function main(): Promise<void> {
  const [repo, out, ...rest] = process.argv.slice(2);
  if (!repo || !out) {
    throw new Error(
      "Usage: build-index.ts <repo> <out.json> [--branch main] [--min-pr N]",
    );
  }
  const branch = flag(rest, "--branch") ?? "HEAD";
  const minPr = Number(flag(rest, "--min-pr") ?? 0);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });

  const events: LineageEvent[] = [];
  const mergedPrs = new Set<number>();

  const commits = git(
    "log",
    "--first-parent",
    "--format=%H%x1f%P%x1f%cI%x1f%s",
    branch,
  )
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, parents, date, subject] = line.split("\x1f");
      return {
        sha,
        parent: parents.split(" ")[0] ?? "",
        date: new Date(date).toISOString(),
        subject,
      };
    });

  for (const commit of commits) {
    if (!commit.parent) continue;
    const pr = /\(#(\d+)\)\s*$/u.exec(commit.subject)?.[1];
    if (pr) mergedPrs.add(Number(pr));
    const change = await describeChange(git, commit.parent, commit.sha);
    if (!change) continue;
    events.push({
      id: `commit:${commit.sha.slice(0, 12)}`,
      kind: "merged-change",
      sha: commit.sha,
      date: commit.date,
      title: commit.subject,
      ...(pr ? { pr: Number(pr) } : {}),
      link: pr ? "recorded" : "none",
      ...change,
    });
  }

  const prRefs = git(
    "for-each-ref",
    "--format=%(refname:strip=3) %(objectname)",
    "refs/remotes/pr",
  )
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [number, sha] = line.split(" ");
      return { pr: Number(number), sha };
    })
    .filter(
      ({ pr }) => Number.isInteger(pr) && pr >= minPr && !mergedPrs.has(pr),
    );

  for (const { pr, sha } of prRefs) {
    let base: string;
    try {
      base = git("merge-base", branch, sha).trim();
    } catch {
      continue;
    }
    if (!base || base === sha) continue;
    const change = await describeChange(git, base, sha);
    if (!change) continue;
    const [date, subject] = git("log", "-1", "--format=%cI%x1f%s", sha)
      .trim()
      .split("\x1f");
    events.push({
      id: `pr:${pr}`,
      kind: "unmerged-attempt",
      sha,
      base,
      date: new Date(date).toISOString(),
      title: subject,
      pr,
      link: "recorded",
      ...change,
    });
  }

  const index: LineageIndex = {
    repo,
    builtAt: new Date().toISOString(),
    events,
    annotations: {},
  };
  await writeFile(out, `${JSON.stringify(index)}\n`, "utf8");
  console.log(
    `${events.length} events (${events.filter((event) => event.kind === "merged-change").length} merged, ${events.filter((event) => event.kind === "unmerged-attempt").length} unmerged attempts) -> ${out}`,
  );
}

/**
 * Lists changed files and changed Rust items between two commits.
 */
async function describeChange(
  git: (...args: string[]) => string,
  from: string,
  to: string,
): Promise<Pick<LineageEvent, "files" | "items"> | undefined> {
  let files: string[];
  try {
    files = git("diff", "--name-only", "--no-renames", from, to)
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    return undefined;
  }
  if (files.length === 0 || files.length > MAX_FILES_PER_EVENT)
    return undefined;
  const items: ItemChange[] = [];
  for (const file of files.filter((candidate) => candidate.endsWith(".rs"))) {
    const before = show(git, from, file);
    const after = show(git, to, file);
    const beforeItems = new Map(
      (before === undefined ? [] : await listRustItems(before)).map((item) => [
        item.path,
        item.fingerprint,
      ]),
    );
    const afterItems = new Map(
      (after === undefined ? [] : await listRustItems(after)).map((item) => [
        item.path,
        item.fingerprint,
      ]),
    );
    for (const [item, fingerprint] of afterItems) {
      const previous = beforeItems.get(item);
      if (previous === undefined) items.push({ file, item, change: "added" });
      else if (previous !== fingerprint)
        items.push({ file, item, change: "modified" });
    }
    for (const item of beforeItems.keys()) {
      if (!afterItems.has(item)) items.push({ file, item, change: "removed" });
    }
  }
  return { files, items };
}

function show(
  git: (...args: string[]) => string,
  sha: string,
  file: string,
): string | undefined {
  try {
    return git("show", `${sha}:${file}`);
  } catch {
    return undefined;
  }
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

await main();
