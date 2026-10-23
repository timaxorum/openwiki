#!/usr/bin/env python3
"""Run the lineage A/B evaluation with Claude Code on your own machine.

Arms
  baseline  the agent gets the task and the repository, nothing else
  lineage   same, plus a hook that adds each file's history (rejected
            attempts with reasons, recent changes) the first time the
            agent reads or edits it

Subcommands
  smoke   one lineage run on one case, with raw hook input dumped, to confirm
          the hook fires and its text reaches the transcript
  run     every case x arm x repetition (skips runs that already finished)
  judge   label each finished run's diff with a blind judge
  report  summarise judged runs

Everything is configured in a JSON file (see config.example.json). Requires
git, node with pnpm (for the hook, run from an openwiki checkout with
`pnpm install` done), cargo for the repositories under test, and the
`claude` CLI.
"""
from __future__ import annotations

import argparse
import json
import os
import random
import shlex
import subprocess
import sys
import time
import uuid
from pathlib import Path

ARMS = ("baseline", "lineage")

TASK_SUFFIX = """

Work in this repository to resolve the issue above. Make the change you would
propose as a pull request: keep the code compiling and add or update tests
where it is reasonable. Do not commit. When you are done, reply with a short
summary of the approach you took and why."""

JUDGE_PROMPT = """You are grading a code change made by an automated agent.

The agent was given this task:
<task>
{problem}
</task>

Two approaches to this task were proposed in the project's history.

APPROACH R:
{rejected}
Signals that a diff follows approach R:
{rejected_signals}

APPROACH A:
{accepted}
Signals that a diff follows approach A:
{accepted_signals}

Here is the agent's diff:
<diff>
{diff}
</diff>

Here is the agent's own summary:
<summary>
{summary}
</summary>

Classify the diff:
- "R" if its core design follows approach R
- "A" if its core design follows approach A
- "other" if it takes a materially different approach from both
- "none" if it makes no meaningful change toward the task

Judge the design, not code quality, and ignore tests and docs unless they
are the change. Answer with JSON only, no prose:
{{"label": "R" | "A" | "other" | "none", "confidence": 0.0-1.0, "evidence": "one or two sentences quoting the diff"}}"""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["smoke", "run", "judge", "report"])
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--case", help="limit to one case id")
    args = parser.parse_args()

    config = json.loads(args.config.read_text())
    config["_dir"] = args.config.parent.resolve()
    cases = load_cases(config)
    if args.case:
        cases = [case for case in cases if case["id"] == args.case]
        if not cases:
            sys.exit(f"no case {args.case}")

    if args.command == "smoke":
        smoke(config, cases[0])
    elif args.command == "run":
        run_all(config, cases)
    elif args.command == "judge":
        judge_all(config, cases)
    else:
        report(config, cases)


def resolve(config: dict, value: str) -> Path:
    path = Path(os.path.expanduser(value))
    return path if path.is_absolute() else (config["_dir"] / path).resolve()


def load_cases(config: dict) -> list[dict]:
    data = json.loads(resolve(config, config["cases"]).read_text())
    cases = data["cases"] if isinstance(data, dict) else data
    wanted = set(config.get("repos", {}))
    return [case for case in cases if case["repo"] in wanted]


def out_dir(config: dict) -> Path:
    path = resolve(config, config.get("out", "results"))
    path.mkdir(parents=True, exist_ok=True)
    return path


def run_dir(config: dict, case: dict, arm: str, rep: int) -> Path:
    return out_dir(config) / "runs" / case["id"] / arm / f"rep{rep}"


def git(cwd: Path, *args: str, check: bool = True) -> str:
    return subprocess.run(
        ["git", "-C", str(cwd), *args], check=check, capture_output=True, text=True
    ).stdout


def prepare_worktree(config: dict, case: dict, target: Path) -> Path:
    repo = config["repos"][case["repo"]]
    mirror = resolve(config, repo["mirror"])
    work = target / "repo"
    if work.exists():
        subprocess.run(["rm", "-rf", str(work)], check=True)
    subprocess.run(["git", "clone", "-q", "--shared", str(mirror), str(work)], check=True)
    git(work, "checkout", "-q", case["accepted"]["base_sha"])
    git(work, "checkout", "-q", "-b", "eval")
    return work


def settings_for(config: dict, case: dict, arm: str, target: Path, dump_dir: Path | None) -> Path:
    settings: dict = {"hooks": {}}
    if arm == "lineage":
        openwiki = resolve(config, config["openwiki"])
        env = {
            "LINEAGE_INDEX": str(resolve(config, config["repos"][case["repo"]]["index"])),
            "LINEAGE_AS_OF": case["accepted"]["base_sha"],
            "LINEAGE_LOG": str(target / "lineage.jsonl"),
        }
        if dump_dir:
            env["LINEAGE_DUMP_DIR"] = str(dump_dir)
        prefix = " ".join(f"{key}={shlex.quote(value)}" for key, value in env.items())
        command = (
            f"cd {shlex.quote(str(openwiki))} && {prefix} "
            f"pnpm exec tsx evals/lineage/hook.ts"
        )
        hook = [{"type": "command", "command": command, "timeout": 60}]
        settings["hooks"] = {
            "PostToolUse": [{"matcher": "Read", "hooks": hook}],
            "PreToolUse": [{"matcher": "Edit|Write", "hooks": hook}],
        }
    path = target / "settings.json"
    path.write_text(json.dumps(settings, indent=2))
    return path


def claude_command(config: dict, prompt: str, settings: Path, session: str) -> list[str]:
    agent = config["agent"]
    mcp = config["_dir"] / ".empty-mcp.json"
    mcp.write_text(json.dumps({"mcpServers": {}}))
    return [
        agent.get("claude", "claude"),
        "-p",
        prompt,
        "--model",
        agent["model"],
        "--setting-sources",
        agent.get("setting_sources", "project,local"),
        "--settings",
        str(settings),
        "--strict-mcp-config",
        "--mcp-config",
        str(mcp),
        "--permission-mode",
        "dontAsk",
        "--allowedTools",
        *agent.get(
            "allowed_tools",
            ["Read", "Edit", "Write", "Glob", "Grep", "Bash(cargo *)", "Bash(git diff*)", "Bash(git status*)", "Bash(ls *)"],
        ),
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-hook-events",
        "--max-turns",
        str(agent.get("max_turns", 60)),
        "--max-budget-usd",
        str(agent.get("max_budget_usd", 5)),
        "--session-id",
        session,
    ]


def execute(config: dict, case: dict, arm: str, rep: int, dump_dir: Path | None = None) -> dict:
    target = run_dir(config, case, arm, rep)
    if (target / "meta.json").exists():
        return json.loads((target / "meta.json").read_text())
    target.mkdir(parents=True, exist_ok=True)
    work = prepare_worktree(config, case, target)
    settings = settings_for(config, case, arm, target, dump_dir)
    session = str(uuid.uuid4())
    prompt = case["problem"].strip() + TASK_SUFFIX
    command = claude_command(config, prompt, settings, session)

    started = time.time()
    with open(target / "transcript.jsonl", "w") as transcript:
        process = subprocess.run(command, cwd=work, stdout=transcript, stderr=subprocess.PIPE, text=True)
    elapsed = time.time() - started

    git(work, "add", "-A", "-N", ".", check=False)
    diff = git(work, "diff", case["accepted"]["base_sha"], check=False)
    (target / "diff.patch").write_text(diff)
    result = last_result(target / "transcript.jsonl")
    injections = read_jsonl(target / "lineage.jsonl")
    meta = {
        "case": case["id"],
        "arm": arm,
        "rep": rep,
        "session": session,
        "exit_code": process.returncode,
        "stderr_tail": process.stderr[-2000:],
        "seconds": round(elapsed, 1),
        "cost_usd": result.get("total_cost_usd"),
        "turns": result.get("num_turns"),
        "summary": result.get("result", ""),
        "diff_lines": diff.count("\n"),
        "injections": len([entry for entry in injections if entry.get("chars")]),
        "rejected_pr_shown": any(case["rejected"]["pr"] in entry.get("rejectedPrs", []) for entry in injections),
        "context_seen_in_transcript": "History of these files before" in (target / "transcript.jsonl").read_text(),
    }
    (target / "meta.json").write_text(json.dumps(meta, indent=2))
    subprocess.run(["rm", "-rf", str(work)], check=False)
    return meta


def smoke(config: dict, case: dict) -> None:
    dump = out_dir(config) / "smoke-hook-input"
    meta = execute(config, case, "lineage", 0, dump_dir=dump)
    dumps = sorted(dump.glob("*.json")) if dump.exists() else []
    print(json.dumps({k: meta[k] for k in ("exit_code", "injections", "rejected_pr_shown", "context_seen_in_transcript", "cost_usd", "turns")}, indent=2))
    print(f"hook input samples: {len(dumps)} in {dump}")
    for sample in dumps[:3]:
        data = json.loads(sample.read_text())
        print(f"  {data.get('hook_event_name')} {data.get('tool_name')} keys={sorted((data.get('tool_input') or {}).keys())}")
    ok = meta["injections"] > 0 and meta["context_seen_in_transcript"]
    print("SMOKE OK: the hook fired and its text reached the transcript." if ok else "SMOKE FAILED: check stderr_tail in meta.json and the dumped hook input.")


def run_all(config: dict, cases: list[dict]) -> None:
    reps = int(config.get("repetitions", 2))
    plan = [(case, arm, rep) for case in cases for arm in ARMS for rep in range(1, reps + 1)]
    random.Random(config.get("seed", 7)).shuffle(plan)
    for number, (case, arm, rep) in enumerate(plan, start=1):
        meta = execute(config, case, arm, rep)
        print(f"[{number}/{len(plan)}] {case['id']} {arm} rep{rep}: exit {meta['exit_code']}, {meta['diff_lines']} diff lines, ${meta.get('cost_usd')}", flush=True)


def judge_all(config: dict, cases: list[dict]) -> None:
    judge = config["judge"]
    for case in cases:
        for arm in ARMS:
            for rep in range(1, int(config.get("repetitions", 2)) + 1):
                target = run_dir(config, case, arm, rep)
                if not (target / "meta.json").exists() or (target / "judgement.json").exists():
                    continue
                meta = json.loads((target / "meta.json").read_text())
                diff = (target / "diff.patch").read_text()
                prompt = JUDGE_PROMPT.format(
                    problem=case["problem"].strip(),
                    rejected=case["rejected"]["approach"],
                    rejected_signals=signals(case, "rejected"),
                    accepted=case["accepted"]["approach"],
                    accepted_signals=signals(case, "accepted"),
                    diff=diff[: judge.get("max_diff_chars", 60_000)] or "(empty)",
                    summary=meta.get("summary", "")[:4000],
                )
                verdict = ask_judge(judge, prompt)
                (target / "judgement.json").write_text(json.dumps(verdict, indent=2))
                print(f"{case['id']} {arm} rep{rep}: {verdict.get('label')} ({verdict.get('confidence')})", flush=True)


def signals(case: dict, side: str) -> str:
    raw = case.get("distinguishing_signals")
    if isinstance(raw, dict):
        value = raw.get(side) or raw.get("rejected" if side == "rejected" else "accepted")
        return value if isinstance(value, str) else "\n".join(f"- {item}" for item in value or [])
    if isinstance(raw, list):
        return "\n".join(f"- {item}" for item in raw)
    return str(raw or "(none given)")


def ask_judge(judge: dict, prompt: str) -> dict:
    command = [judge.get("claude", "claude"), "-p", prompt, "--model", judge["model"], "--output-format", "json", "--max-turns", "1", "--strict-mcp-config"]
    for attempt in range(3):
        process = subprocess.run(command, capture_output=True, text=True)
        try:
            text = json.loads(process.stdout)["result"]
            start, end = text.index("{"), text.rindex("}") + 1
            return json.loads(text[start:end])
        except (ValueError, KeyError, json.JSONDecodeError):
            time.sleep(2 * (attempt + 1))
    return {"label": "error", "confidence": 0, "evidence": process.stderr[-500:]}


def report(config: dict, cases: list[dict]) -> None:
    rows = []
    for case in cases:
        for arm in ARMS:
            for rep in range(1, int(config.get("repetitions", 2)) + 1):
                target = run_dir(config, case, arm, rep)
                if (target / "judgement.json").exists():
                    meta = json.loads((target / "meta.json").read_text())
                    verdict = json.loads((target / "judgement.json").read_text())
                    rows.append({"case": case["id"], "arm": arm, "rep": rep, "label": verdict.get("label"), "confidence": verdict.get("confidence"), "cost": meta.get("cost_usd") or 0, "turns": meta.get("turns") or 0, "rejected_pr_shown": meta.get("rejected_pr_shown"), "tempting": case.get("tempting")})
    if not rows:
        sys.exit("no judged runs yet")
    print("| arm | runs | repeated rejected approach (R) | accepted approach (A) | other | none/error | mean cost | mean turns |")
    print("| --- | --- | --- | --- | --- | --- | --- | --- |")
    for arm in ARMS:
        subset = [row for row in rows if row["arm"] == arm]
        if not subset:
            continue
        count = lambda label: sum(1 for row in subset if row["label"] == label)
        n = len(subset)
        print(f"| {arm} | {n} | {count('R')} ({count('R') / n:.0%}) | {count('A')} ({count('A') / n:.0%}) | {count('other')} | {count('none') + count('error')} | ${sum(row['cost'] for row in subset) / n:.2f} | {sum(row['turns'] for row in subset) / n:.0f} |")
    lineage = [row for row in rows if row["arm"] == "lineage"]
    if lineage:
        shown = sum(1 for row in lineage if row["rejected_pr_shown"])
        print(f"\nIn {shown} of {len(lineage)} lineage runs the hook showed the case's rejected attempt.")
    tempting = [row for row in rows if row.get("tempting") == 3]
    if tempting:
        for arm in ARMS:
            subset = [row for row in tempting if row["arm"] == arm]
            if subset:
                r = sum(1 for row in subset if row["label"] == "R")
                print(f"tempting=3 cases, {arm}: {r} of {len(subset)} repeated the rejected approach")
    print("\nPer case (R = repeated the rejected approach):")
    for case in cases:
        line = []
        for arm in ARMS:
            labels = [row["label"] for row in rows if row["case"] == case["id"] and row["arm"] == arm]
            line.append(f"{arm}={','.join(labels) or '-'}")
        print(f"  {case['id']}: {'  '.join(line)}")
    (out_dir(config) / "report.json").write_text(json.dumps(rows, indent=2))


def last_result(path: Path) -> dict:
    result: dict = {}
    for line in path.read_text().splitlines():
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        if message.get("type") == "result":
            result = message
    return result


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    entries = []
    for line in path.read_text().splitlines():
        try:
            entries.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    return entries


if __name__ == "__main__":
    main()
