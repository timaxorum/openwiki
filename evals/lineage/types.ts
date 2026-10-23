/**
 * Shared types for the lineage index and context assembler.
 */

/**
 * One Rust item changed by an event.
 */
export interface ItemChange {
  /** Repository-relative file path. */
  file: string;
  /** File-relative item path, as produced by `listRustItems`. */
  item: string;
  /** How the item changed. */
  change: "added" | "modified" | "removed";
}

/**
 * One change to the code base: a commit on the default branch, or an
 * attempt that never merged.
 */
export interface LineageEvent {
  /** Stable id such as `commit:<sha12>` or `pr:<number>`. */
  id: string;
  /** A default-branch commit, or an unmerged pull-request attempt. */
  kind: "merged-change" | "unmerged-attempt";
  /** Commit (or PR head) SHA. */
  sha: string;
  /** For unmerged attempts, the merge-base the attempt started from. */
  base?: string;
  /** Committer date of `sha`, ISO 8601. */
  date: string;
  /** Commit subject. */
  title: string;
  /** Pull-request number, when known. */
  pr?: number;
  /**
   * Whether the event is linked to a PR, issue, or session by a recorded key
   * (a `(#N)` subject or a `refs/pull/N` ref) or not linked at all.
   */
  link: "recorded" | "none";
  /** Every changed file. */
  files: string[];
  /** Changed Rust items. */
  items: ItemChange[];
}

/**
 * Rationale attached to a pull request from its discussion.
 */
export interface Annotation {
  /** Pull-request title, when it differs from the head commit subject. */
  title?: string;
  /** What the change or attempt did, in a sentence or two. */
  summary?: string;
  /** Why it was rejected, for unmerged attempts; a short quote. */
  reason?: string;
  /** Who gave the reason. */
  by?: string;
  /** Where the reason was given. */
  url?: string;
  /** When the PR was closed or merged, ISO 8601. */
  closedAt?: string;
}

/**
 * Lineage index for one repository.
 */
export interface LineageIndex {
  /** Repository path the index was built from. */
  repo: string;
  /** Build time, ISO 8601. */
  builtAt: string;
  /** Events in no particular order. */
  events: LineageEvent[];
  /** Rationale keyed by PR number. */
  annotations: Record<string, Annotation>;
}
