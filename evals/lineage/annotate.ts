/**
 * Merges rationale into a lineage index.
 *
 * Usage:
 *   pnpm exec tsx evals/lineage/annotate.ts <index.json> <cases.json> [annotations.json ...] [--out <file>]
 *
 * `cases.json` (from case mining) contributes each case's rejected attempt:
 * its title, approach, reason, reviewer and close date. Further files are
 * plain `{ "<pr>": Annotation }` maps, used for distractor attempts so the
 * case's rejected PR is not the only attempt with a recorded reason.
 * Accepted PRs are never annotated: they are what the evaluation hides.
 */
import { readFile, writeFile } from "node:fs/promises";
import type { Annotation, LineageIndex } from "./types.ts";

interface MinedCase {
  id: string;
  rejected: {
    pr: number;
    title?: string;
    closed_at?: string;
    approach?: string;
    reason?: string;
    reviewer?: string;
    reason_url?: string;
    url?: string;
  };
  accepted: { pr: number };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const out = outIndex === -1 ? undefined : args.splice(outIndex, 2)[1];
  const [indexPath, casesPath, ...extra] = args;
  if (!indexPath || !casesPath) {
    throw new Error(
      "Usage: annotate.ts <index.json> <cases.json> [annotations.json ...] [--out file]",
    );
  }
  const index = JSON.parse(await readFile(indexPath, "utf8")) as LineageIndex;
  const { cases } = JSON.parse(await readFile(casesPath, "utf8")) as {
    cases: MinedCase[];
  };
  const hidden = new Set(cases.map((item) => String(item.accepted.pr)));

  let added = 0;
  for (const item of cases) {
    const annotation: Annotation = {
      ...(item.rejected.title ? { title: item.rejected.title } : {}),
      ...(item.rejected.approach ? { summary: item.rejected.approach } : {}),
      ...(item.rejected.reason ? { reason: item.rejected.reason } : {}),
      ...(item.rejected.reviewer ? { by: item.rejected.reviewer } : {}),
      ...((item.rejected.reason_url ?? item.rejected.url)
        ? { url: item.rejected.reason_url ?? item.rejected.url }
        : {}),
      ...(item.rejected.closed_at ? { closedAt: item.rejected.closed_at } : {}),
    };
    index.annotations[String(item.rejected.pr)] = {
      ...index.annotations[String(item.rejected.pr)],
      ...annotation,
    };
    added += 1;
  }
  for (const file of extra) {
    const map = JSON.parse(await readFile(file, "utf8")) as Record<
      string,
      Annotation
    >;
    for (const [pr, annotation] of Object.entries(map)) {
      if (hidden.has(pr)) continue;
      index.annotations[pr] = { ...index.annotations[pr], ...annotation };
      added += 1;
    }
  }
  await writeFile(out ?? indexPath, `${JSON.stringify(index)}\n`, "utf8");
  console.log(
    `${added} annotations merged; ${Object.keys(index.annotations).length} PRs annotated.`,
  );
}

await main();
