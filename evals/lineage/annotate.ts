/**
 * Merges rationale into a lineage index.
 *
 * Usage:
 *   pnpm exec tsx evals/lineage/annotate.ts <index.json> <cases.json> --repo <owner/name> --mirror <path>
 *     [--extra annotations.json ...] [--out <file>]
 *
 * `cases.json` (from case mining) contributes each case's rejected attempt:
 * its title, approach, reasons, reviewer and close date. Only cases for
 * `--repo` are used. `--extra` files are plain `{ "<pr>": Annotation }` maps for
 * distractor attempts, so the case's rejected PR is not the only attempt with
 * a recorded reason. Accepted PRs are never annotated: they are what the
 * evaluation hides.
 *
 * Visibility: when mining found that the maintainers' objection was posted
 * before the accepted PR was opened, the rejected attempt is visible from the
 * accepted PR's base commit, even if the PR closed later. Otherwise it is
 * visible only from its close date, so it stays hidden from its own case.
 */
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { loadIndex } from "./assemble.ts";
import type { Annotation, LineageIndex } from "./types.ts";

interface Reason {
  quote: string;
  url?: string;
  by?: string;
}

interface MinedCase {
  id: string;
  repo: string;
  rejected: {
    pr: number;
    title?: string;
    closed_at?: string;
    approach?: string;
    reason?: string | Reason[];
    reviewer?: string;
    url?: string;
  };
  accepted: { pr: number; base_sha: string };
  ordering?: { rejection_reason_predates_accepted_opened?: boolean };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const take = (name: string): string[] => {
    const values: string[] = [];
    for (
      let index = args.indexOf(name);
      index !== -1;
      index = args.indexOf(name)
    ) {
      values.push(args[index + 1]);
      args.splice(index, 2);
    }
    return values;
  };
  const out = take("--out")[0];
  const repo = take("--repo")[0];
  const mirror = take("--mirror")[0];
  const extra = take("--extra");
  const [indexPath, casesPath] = args;
  if (!indexPath || !casesPath || !repo || !mirror) {
    throw new Error(
      "Usage: annotate.ts <index.json> <cases.json> --repo <owner/name> --mirror <path> [--extra file ...] [--out file]",
    );
  }
  const index = await loadIndex(indexPath);
  const cases = (
    JSON.parse(await readFile(casesPath, "utf8")) as { cases: MinedCase[] }
  ).cases.filter((item) => item.repo === repo);
  const hidden = new Set(cases.map((item) => String(item.accepted.pr)));

  for (const item of cases) {
    const reasons = normalizeReasons(
      item.rejected.reason,
      item.rejected.reviewer,
    );
    const baseDate = new Date(
      execFileSync(
        "git",
        ["-C", mirror, "log", "-1", "--format=%cI", item.accepted.base_sha],
        {
          encoding: "utf8",
        },
      ).trim(),
    ).toISOString();
    const known =
      item.ordering?.rejection_reason_predates_accepted_opened === true;
    const annotation: Annotation = {
      ...(item.rejected.title ? { title: item.rejected.title } : {}),
      ...(item.rejected.approach ? { summary: item.rejected.approach } : {}),
      ...(reasons.length > 0
        ? { reason: reasons.map((reason) => reason.quote).join(" … ") }
        : {}),
      ...(reasons[0]?.by
        ? {
            by: [
              ...new Set(reasons.map((reason) => reason.by).filter(Boolean)),
            ].join(", "),
          }
        : {}),
      ...((reasons[0]?.url ?? item.rejected.url)
        ? { url: reasons[0]?.url ?? item.rejected.url }
        : {}),
      ...(item.rejected.closed_at
        ? { closedAt: new Date(item.rejected.closed_at).toISOString() }
        : {}),
      ...(known ? { visibleFrom: baseDate } : {}),
    };
    index.annotations[String(item.rejected.pr)] = {
      ...index.annotations[String(item.rejected.pr)],
      ...annotation,
    };
  }

  let extras = 0;
  for (const file of extra) {
    const map = JSON.parse(await readFile(file, "utf8")) as Record<
      string,
      Annotation
    >;
    for (const [pr, annotation] of Object.entries(map)) {
      if (
        hidden.has(pr) ||
        cases.some((item) => String(item.rejected.pr) === pr)
      )
        continue;
      if ((annotation as { merged?: boolean }).merged) continue;
      index.annotations[pr] = { ...index.annotations[pr], ...annotation };
      extras += 1;
    }
  }
  await writeFile(out ?? indexPath, `${JSON.stringify(index)}\n`, "utf8");
  console.log(
    `${cases.length} case annotations and ${extras} distractor annotations merged; ${Object.keys(index.annotations).length} PRs annotated.`,
  );
}

function normalizeReasons(
  reason: MinedCase["rejected"]["reason"],
  reviewer?: string,
): Reason[] {
  if (!reason) return [];
  if (typeof reason === "string")
    return [{ quote: reason, ...(reviewer ? { by: reviewer } : {}) }];
  return reason.filter((entry) => entry.quote?.trim());
}

await main();
