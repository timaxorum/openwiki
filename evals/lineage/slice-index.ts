/**
 * Writes the part of a lineage index visible at one commit.
 *
 * Usage:
 *   pnpm exec tsx evals/lineage/slice-index.ts <index.json[.gz]> <mirror> <sha> <out.json>
 */
import { writeFile } from "node:fs/promises";
import { loadIndex, resolveAsOf, sliceIndex } from "./assemble.ts";

const [indexPath, mirror, sha, out] = process.argv.slice(2);
if (!indexPath || !mirror || !sha || !out) {
  throw new Error(
    "Usage: slice-index.ts <index.json[.gz]> <mirror> <sha> <out.json>",
  );
}
const sliced = sliceIndex(await loadIndex(indexPath), resolveAsOf(mirror, sha));
await writeFile(out, `${JSON.stringify(sliced)}\n`, "utf8");
console.log(
  `${sliced.events.length} events visible at ${sha.slice(0, 7)} -> ${out}`,
);
