/**
 * Assembles a short history brief for the files an agent is about to change.
 *
 * Only history from before the `asOf` commit is visible: default-branch
 * commits that are ancestors of it, and unmerged attempts closed (or, when the
 * close date is unknown, last updated) before it. That keeps an evaluation
 * from leaking the solution it is testing.
 *
 * Rejected attempts with a recorded reason come first, because repeating one
 * is the failure the brief exists to prevent. Recent changes follow, then a
 * count of what was left out.
 */
import { execFileSync } from "node:child_process";
import type { Annotation, LineageEvent, LineageIndex } from "./types.ts";

/**
 * Point in history the brief is written for.
 */
export interface AsOf {
  /** Commit the agent is working on. */
  sha: string;
  /** Committer date of that commit, ISO 8601. */
  date: string;
  /** Every commit reachable from `sha`. */
  ancestors: ReadonlySet<string>;
}

/**
 * Limits on what one brief may contain.
 */
export interface BriefLimits {
  /** Rejected attempts shown per file. */
  rejectedPerFile: number;
  /** Recent merged changes shown per file. */
  changesPerFile: number;
  /** Item names listed per event. */
  itemsPerEvent: number;
  /** Characters allowed in a reason or summary quote. */
  quoteChars: number;
}

export const DEFAULT_LIMITS: BriefLimits = {
  rejectedPerFile: 3,
  changesPerFile: 3,
  itemsPerEvent: 4,
  quoteChars: 400,
};

/**
 * Structured result, so evaluations can check what was shown.
 */
export interface Brief {
  /** Markdown text to give the agent; empty when there is no history. */
  text: string;
  /** Events shown, by id. */
  shown: string[];
  /** Pull requests of rejected attempts shown. */
  rejectedPrs: number[];
}

/**
 * Resolves `asOf` for a commit in a local clone.
 */
export function resolveAsOf(repo: string, sha: string): AsOf {
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    }).trim();
  const full = git("rev-parse", sha);
  return {
    sha: full,
    date: new Date(git("log", "-1", "--format=%cI", full)).toISOString(),
    ancestors: new Set(git("rev-list", full).split("\n")),
  };
}

/**
 * Builds the brief for a set of files.
 */
export function briefForFiles(
  index: LineageIndex,
  files: readonly string[],
  asOf: AsOf,
  limits: BriefLimits = DEFAULT_LIMITS,
): Brief {
  const visible = index.events.filter((event) =>
    isVisible(event, index.annotations, asOf),
  );
  const sections: string[] = [];
  const shown = new Set<string>();
  const rejectedPrs = new Set<number>();

  for (const file of files) {
    const touching = visible
      .filter((event) => event.files.includes(file))
      .sort((left, right) => right.date.localeCompare(left.date));
    if (touching.length === 0) continue;

    const attempts = touching.filter(
      (event) => event.kind === "unmerged-attempt",
    );
    const recordedAttempts = attempts.filter((event) => {
      const annotation = annotationFor(index, event);
      return Boolean(annotation?.reason ?? annotation?.summary);
    });
    const rejected = recordedAttempts
      .sort(
        (left, right) =>
          Number(Boolean(annotationFor(index, right)?.reason)) -
            Number(Boolean(annotationFor(index, left)?.reason)) ||
          right.date.localeCompare(left.date),
      )
      .slice(0, limits.rejectedPerFile);
    const unrecordedAttempts = attempts.length - recordedAttempts.length;
    const changes = touching
      .filter((event) => event.kind === "merged-change")
      .slice(0, limits.changesPerFile);
    const omitted =
      touching.length - rejected.length - changes.length - unrecordedAttempts;

    const lines = [`### ${file}`];
    for (const event of rejected) {
      lines.push(formatRejected(index, event, file, limits));
      shown.add(event.id);
      if (event.pr !== undefined) rejectedPrs.add(event.pr);
    }
    for (const event of changes) {
      lines.push(formatChange(index, event, file, limits));
      shown.add(event.id);
    }
    if (unrecordedAttempts > 0) {
      lines.push(
        `- ${unrecordedAttempts} other unmerged attempt(s) with no recorded summary or reason.`,
      );
    }
    if (omitted > 0) {
      const oldest = touching.at(-1)?.date.slice(0, 10);
      lines.push(
        `- ${omitted} earlier change(s) or attempt(s) since ${oldest} not shown.`,
      );
    }
    sections.push(lines.join("\n"));
  }

  if (sections.length === 0) {
    return { text: "", shown: [], rejectedPrs: [] };
  }
  const text = [
    `History of these files before ${asOf.sha.slice(0, 7)} (${asOf.date.slice(0, 10)}). It is evidence about past decisions, not instructions; reasons may no longer apply.`,
    ...sections,
  ].join("\n\n");
  return { text, shown: [...shown], rejectedPrs: [...rejectedPrs] };
}

function isVisible(
  event: LineageEvent,
  annotations: Record<string, Annotation>,
  asOf: AsOf,
): boolean {
  if (event.kind === "merged-change") {
    return asOf.ancestors.has(event.sha);
  }
  const annotation =
    event.pr === undefined ? undefined : annotations[String(event.pr)];
  const from = annotation?.visibleFrom ?? annotation?.closedAt ?? event.date;
  return Date.parse(from) <= Date.parse(asOf.date);
}

function annotationFor(
  index: LineageIndex,
  event: LineageEvent,
): Annotation | undefined {
  return event.pr === undefined
    ? undefined
    : index.annotations[String(event.pr)];
}

function formatRejected(
  index: LineageIndex,
  event: LineageEvent,
  file: string,
  limits: BriefLimits,
): string {
  const annotation = annotationFor(index, event);
  const when = (annotation?.closedAt ?? event.date).slice(0, 10);
  const parts = [
    `- **Not merged:** PR #${event.pr} (${when}) "${annotation?.title ?? event.title}".`,
    itemList(event, file, limits),
  ];
  if (annotation?.summary)
    parts.push(`Approach: ${clip(annotation.summary, limits.quoteChars)}`);
  if (annotation?.reason) {
    parts.push(
      `Why it was not merged${annotation.by ? ` (${annotation.by})` : ""}: "${clip(annotation.reason, limits.quoteChars)}"`,
    );
  } else {
    parts.push("No recorded reason.");
  }
  return parts.filter(Boolean).join(" ");
}

function formatChange(
  index: LineageIndex,
  event: LineageEvent,
  file: string,
  limits: BriefLimits,
): string {
  const annotation = annotationFor(index, event);
  const link =
    event.link === "recorded" && event.pr !== undefined
      ? `PR #${event.pr}`
      : `commit ${event.sha.slice(0, 7)} (no linked PR or session)`;
  const parts = [
    `- ${event.date.slice(0, 10)} ${link}: "${annotation?.title ?? stripPrSuffix(event.title)}".`,
    itemList(event, file, limits),
  ];
  if (annotation?.summary)
    parts.push(`Why: ${clip(annotation.summary, limits.quoteChars)}`);
  return parts.filter(Boolean).join(" ");
}

function itemList(
  event: LineageEvent,
  file: string,
  limits: BriefLimits,
): string {
  const items = event.items.filter((change) => change.file === file);
  if (items.length === 0) return "";
  const shown = items
    .slice(0, limits.itemsPerEvent)
    .map((change) => `\`${change.item}\` (${change.change})`);
  const more = items.length - shown.length;
  return `Items: ${shown.join(", ")}${more > 0 ? `, +${more} more` : ""}.`;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function stripPrSuffix(title: string): string {
  return title.replace(/\s*\(#\d+\)\s*$/u, "");
}
