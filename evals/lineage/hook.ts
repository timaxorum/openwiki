/**
 * Claude Code hook that adds a file's history the first time the agent reads
 * or edits it.
 *
 * Register it for `PostToolUse` on `Read` (documented to accept
 * `additionalContext`) and, optionally, `PreToolUse` on `Edit|Write`.
 * Configuration comes from the environment:
 *
 * - LINEAGE_INDEX: path to an annotated lineage index (required)
 * - LINEAGE_AS_OF: commit the run starts from; only earlier history is shown (required)
 * - LINEAGE_LOG: JSON-lines file recording every injection (optional)
 * - LINEAGE_DUMP_DIR: directory to dump raw hook input, for smoke tests (optional)
 *
 * The hook never blocks a tool call: on any error it logs and exits 0 with no output.
 */
import { execFileSync } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { briefForFiles, resolveAsOf, loadIndex } from "./assemble.ts";
import type { LineageIndex } from "./types.ts";

/**
 * Documented per-string limit for additionalContext is 10,000 characters.
 */
const MAX_CONTEXT_CHARS = 9_500;

interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { file_path?: string; path?: string };
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const input = JSON.parse(raw) as HookInput;
  const dumpDir = process.env.LINEAGE_DUMP_DIR;
  if (dumpDir) {
    await mkdir(dumpDir, { recursive: true });
    await writeFile(
      path.join(
        dumpDir,
        `${Date.now()}-${input.hook_event_name ?? "event"}.json`,
      ),
      raw,
    );
  }

  const indexPath = process.env.LINEAGE_INDEX;
  const asOfSha = process.env.LINEAGE_AS_OF;
  const filePath = input.tool_input?.file_path ?? input.tool_input?.path;
  const cwd = input.cwd ?? process.cwd();
  if (!indexPath || !asOfSha || !filePath || !input.hook_event_name) return;

  // The agent may have changed directory; paths are relative to the repo root.
  const root = execFileSync(
    "git",
    ["-C", cwd, "rev-parse", "--show-toplevel"],
    {
      encoding: "utf8",
    },
  ).trim();
  const relative = path
    .relative(root, path.resolve(cwd, filePath))
    .split(path.sep)
    .join("/");
  if (relative.startsWith("..") || path.isAbsolute(relative)) return;

  const seenPath = path.join(
    tmpdir(),
    `lineage-seen-${input.session_id ?? "unknown"}.json`,
  );
  const seen = new Set<string>(await readJson<string[]>(seenPath, []));
  if (seen.has(relative)) return;
  seen.add(relative);
  await writeFile(seenPath, JSON.stringify([...seen]));

  const index = await loadIndex(indexPath);
  const asOf = resolveAsOf(root, asOfSha);
  const brief = briefForFiles(index, [relative], asOf);

  await log({
    at: new Date().toISOString(),
    session: input.session_id,
    event: input.hook_event_name,
    tool: input.tool_name,
    file: relative,
    chars: brief.text.length,
    shown: brief.shown,
    rejectedPrs: brief.rejectedPrs,
  });
  if (!brief.text) return;

  const text =
    brief.text.length > MAX_CONTEXT_CHARS
      ? `${brief.text.slice(0, MAX_CONTEXT_CHARS - 1)}…`
      : brief.text;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: input.hook_event_name,
        additionalContext: text,
      },
    }),
  );
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function log(entry: Record<string, unknown>): Promise<void> {
  const file = process.env.LINEAGE_LOG;
  if (file) await appendFile(file, `${JSON.stringify(entry)}\n`);
}

try {
  await main();
} catch (error) {
  await log({
    at: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
  }).catch(() => undefined);
}
