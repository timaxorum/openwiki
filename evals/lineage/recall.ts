/**
 * Checks, without any model, whether the brief would surface each case's
 * rejected attempt where the agent is likely to work.
 *
 * For each case the brief is built at the accepted PR's base commit for the
 * files the accepted PR changed (where a correct solution works) and,
 * separately, the files the rejected PR changed (where a repeat would work).
 * A case passes if either brief shows the rejected PR with its reason.
 *
 * Usage:
 *   pnpm exec tsx evals/lineage/recall.ts <repo> <index.json> <cases.json>
 */
import { readFile } from "node:fs/promises";
import { briefForFiles, resolveAsOf } from "./assemble.ts";
import type { LineageIndex } from "./types.ts";

interface Case {
  id: string;
  repo: string;
  rejected: { pr: number; files?: string[]; files_touched?: string[] };
  accepted: {
    pr: number;
    base_sha: string;
    files?: string[];
    files_touched?: string[];
  };
}

async function main(): Promise<void> {
  const [repo, indexPath, casesPath] = process.argv.slice(2);
  if (!repo || !indexPath || !casesPath) {
    throw new Error("Usage: recall.ts <repo> <index.json> <cases.json>");
  }
  const index = JSON.parse(await readFile(indexPath, "utf8")) as LineageIndex;
  const { cases } = JSON.parse(await readFile(casesPath, "utf8")) as {
    cases: Case[];
  };
  const rows: string[] = [];
  let surfaced = 0;
  let considered = 0;
  for (const item of cases) {
    if (
      !repo.toLowerCase().includes(item.repo.split("/").at(-1)!.toLowerCase())
    )
      continue;
    considered += 1;
    let asOf;
    try {
      asOf = resolveAsOf(repo, item.accepted.base_sha);
    } catch {
      rows.push(
        `| ${item.id} | base ${item.accepted.base_sha.slice(0, 7)} not in clone | | |`,
      );
      continue;
    }
    const acceptedFiles = (
      item.accepted.files ??
      item.accepted.files_touched ??
      []
    ).filter((file) => file.endsWith(".rs"));
    const rejectedFiles = (
      item.rejected.files ??
      item.rejected.files_touched ??
      []
    ).filter((file) => file.endsWith(".rs"));
    const atAccepted = briefForFiles(index, acceptedFiles, asOf);
    const atRejected = briefForFiles(index, rejectedFiles, asOf);
    const hit =
      atAccepted.rejectedPrs.includes(item.rejected.pr) ||
      atRejected.rejectedPrs.includes(item.rejected.pr);
    if (hit) surfaced += 1;
    const visible = index.events.some(
      (event) =>
        event.pr === item.rejected.pr && event.kind === "unmerged-attempt",
    );
    rows.push(
      `| ${item.id} | ${hit ? "yes" : visible ? "no" : "no (attempt not in index)"} | ${atAccepted.text.length} / ${atRejected.text.length} | ${atAccepted.rejectedPrs.length + atRejected.rejectedPrs.length} |`,
    );
  }
  console.log(
    "| case | rejected attempt surfaced | brief chars (accepted files / rejected files) | attempts with reasons shown |",
  );
  console.log("| --- | --- | --- | --- |");
  console.log(rows.join("\n"));
  console.log(
    `\n${surfaced} of ${considered} cases surfaced the rejected attempt.`,
  );
}

await main();
