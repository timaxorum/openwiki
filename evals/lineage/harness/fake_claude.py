#!/usr/bin/env python3
"""Stand-in for the `claude` CLI, used to dry-run the harness without a model.

As the agent it appends a function to the first .rs file under src/ and
prints a stream-json result line; as the judge it returns a JSON verdict.
"""
import json
import sys
from pathlib import Path

args = sys.argv[1:]
if "--output-format" in args and args[args.index("--output-format") + 1] == "json":
    print(json.dumps({"type": "result", "result": json.dumps({"label": "A", "confidence": 0.5, "evidence": "dry run"})}))
    sys.exit(0)

target = next(Path.cwd().rglob("src/lib.rs"), None)
if target:
    with open(target, "a") as handle:
        handle.write("\npub fn dry_run_marker() {}\n")
print(json.dumps({"type": "system", "subtype": "init"}))
print(json.dumps({"type": "result", "result": "Dry run: added a marker function.", "total_cost_usd": 0.0, "num_turns": 1}))
