# Lineage evaluation: does history stop agents repeating rejected approaches?

The question: if an agent is told, at the moment it opens a file, what was
tried there before and why it was rejected, does it repeat rejected
approaches less often?

## Design

Each **case** is a problem that was attempted twice in a real repository:
first in a pull request that maintainers rejected for a design reason, then
in a different approach that merged. The agent gets the problem, worded as an
issue, in a checkout of the commit the merged PR started from. At that commit
the rejected attempt was already history.

Two arms, same prompt, same model, same tools:

| Arm        | What the agent gets                                                                                                                                                                                                                                                                                         |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseline` | The task and the repository.                                                                                                                                                                                                                                                                                |
| `lineage`  | The same, plus a Claude Code hook. The first time the agent reads (`PostToolUse` on `Read`) or edits (`PreToolUse` on `Edit\|Write`) a file, the hook adds that file's history from before the base commit: unmerged attempts with their recorded reasons, recent changes, and counts of what was left out. |

A blind judge labels each diff as the rejected approach (R), the accepted
approach (A), something else, or no change. It sees the two approaches and
their distinguishing signals, but not which arm produced the diff.

**Primary measure:** the share of runs labelled R, lineage vs baseline,
compared within each case. Secondary measures: the share labelled A, cost
and turns, and whether the hook actually showed the rejected attempt.

## Pieces

| File             | What it does                                                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `build-index.ts` | Builds a lineage index from git: every default-branch change and every unmerged PR attempt, with the Rust items each touched. |
| `annotate.ts`    | Merges rationale (titles, approach summaries, rejection reasons) into the index. Accepted PRs are never annotated.            |
| `assemble.ts`    | Builds the per-file history brief, using only history from before the base commit.                                            |
| `hook.ts`        | The Claude Code hook used by the `lineage` arm.                                                                               |
| `recall.ts`      | Checks, without a model, that the brief surfaces each case's rejected attempt.                                                |
| `harness/run.py` | Runs `smoke`, `run`, `judge` and `report` on your machine.                                                                    |
| `cases/`         | Mined cases, distractor annotations, and the annotated index.                                                                 |

## Running it

Prerequisites: `git`, `cargo`, Node 22 with `pnpm`, Python 3.10+, and the
`claude` CLI signed in.

```bash
# 1. This branch of openwiki, with dependencies
git clone -b lineage-eval https://github.com/timaxorum/openwiki ~/openwiki-lineage
cd ~/openwiki-lineage && pnpm install

# 2. A full mirror of each repository under test (the agents work in
#    clones of these; the case base commits must be present)
git clone https://github.com/tokio-rs/axum ~/eval-mirrors/axum
git clone https://github.com/tokio-rs/tokio ~/eval-mirrors/tokio

# 3. Configuration. The indexes ship in cases/ as .json.gz; nothing to build.
cp evals/lineage/harness/config.example.json evals/lineage/harness/config.json
#    edit the model, mirror paths and budget if needed

# 4. Smoke test: one lineage run on one case. It must print SMOKE OK.
python3 evals/lineage/harness/run.py smoke --config evals/lineage/harness/config.json

# 5. The evaluation, then judging and the report
python3 evals/lineage/harness/run.py run    --config evals/lineage/harness/config.json
python3 evals/lineage/harness/run.py judge  --config evals/lineage/harness/config.json
python3 evals/lineage/harness/run.py report --config evals/lineage/harness/config.json
```

`run` shuffles the order of runs with a fixed seed and skips runs that
already finished, so it is safe to stop and restart. Each run's transcript,
diff, hook log and metadata go to `results/runs/<case>/<arm>/rep<N>/`.

Agent runs use `--setting-sources project,local`, so your own
`~/.claude/settings.json` hooks (for example a memory tool) do not leak into
either arm. They also use `--strict-mcp-config` with no servers, and
`--permission-mode dontAsk`, which allows only reading, editing, `cargo`, and
read-only `git`. Each run has a turn and dollar cap set in the config.

Send back `results/report.json` and the `results/runs` folder (transcripts
included), so the judge's labels can be audited.

**Size and cost.** 20 cases (18 primary, 2 controls) × 2 arms × 2
repetitions = 80 agent runs, plus 80 one-turn judge calls. Each agent run is
capped by `max_budget_usd` (5 by default), so the worst case is $400 of
agent time; most runs should stop well short of the cap. To try it small
first, set `"repetitions": 1` and `"roles": ["primary"]` (36 runs), or pass
`--case <id>` to run one case.

## Cases

`cases/cases.json` holds 21 cases mined from tokio-rs/axum (13) and
tokio-rs/tokio (8). ripgrep was searched but yielded none, because its
author lands rejected ideas as edited direct commits rather than as separate
PRs.

| Role       | Count | Meaning                                                                                                                                  |
| ---------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `primary`  | 18    | The rejected attempt and the maintainers' objection are visible at the accepted PR's base commit.                                        |
| `control`  | 2     | The objection came after the accepted work began (axum-2301, axum-3308), so history cannot help. Lineage should make no difference here. |
| `excluded` | 1     | axum-1655: the rejected PR's branch was force-reset upstream, so its diff cannot be recovered.                                           |

Most rejections are about API surface or placement ("extend the existing
type, don't add a new one", "this belongs in axum-extra or tokio-util", "this
breaks semver"), not runtime behaviour. Two cases point in opposite
directions on placement (tokio-4538 moved out of core, tokio-4238 moved into
it), so a fixed "keep it out of core" habit cannot score well on both.

Eight problem statements were edited because they restated the
maintainers' objection or pointed at the accepted mechanism. The original
text is kept in `problem_original`, with the reason in `problem_edit`.

**Distractors.** The case's own rejected PR must not be the only attempt with
a recorded reason, or it would stand out by format alone. The 147 other
closed PRs that touch the case files were summarised from their own
discussions (`cases/*-distractor-annotations.json`); 41 have a maintainer's
stated reason. Of the 147, 66 turned out to have been merged with a merge
commit, so they are treated as merged changes, not attempts.

**No-model check** (`recall.ts`): for all 18 primary cases, the brief for
the files the accepted or rejected PR touched shows the rejected attempt with
its reason.

## Known limits

- **Rationale quality is uneven.** Case PRs carry mined reasons; other PRs
  carry what could be gathered from their discussions; commits carry only
  their titles. A real system would have session records for every change.
- **The judge is a model.** Labels need a sample audit by hand, and the
  report prints judge confidence for that reason.
- **Small samples.** With 15–25 cases and two repetitions per arm, only a
  large effect will be clear. The per-case table matters more than the
  headline rate.
- **History can mislead.** The brief says reasons may no longer apply. Cases
  where following old history would be wrong are not covered yet.
- **Reasons sometimes name the fix.** In several cases the maintainer's
  objection also suggested the accepted approach (for example axum-3464:
  "what you're really looking for is `method_not_allowed_fallback`"). That is
  realistic, since this is exactly what a history store would hold, but it
  means the lineage arm can be steered towards A as well as away from R.
- **Files outside the case.** The hook adds history for any file the agent
  opens, but distractor reasons were only gathered for files the case PRs
  touched. Elsewhere the brief shows merged changes and counts of attempts.
