import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { OpenWikiIgnore } from "../../../src/agent/openwiki-ignore.ts";
import { buildRustPlanningContext } from "../../../src/languages/rust/index.ts";
import {
  readRustWorkspace,
  renderRustWorkspace,
} from "../../../src/languages/rust/workspace.ts";

describe("readRustWorkspace", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "openwiki-rust-workspace-"));
  });

  afterEach(async () => {
    await rm(rootDir, { force: true, recursive: true });
  });

  async function write(relativePath: string, content: string): Promise<void> {
    const absolutePath = path.join(rootDir, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
  }

  async function writeWorkspace(): Promise<void> {
    await write(
      "Cargo.toml",
      `[workspace]
members = ["crates/*", "tools/cli"]
exclude = ["crates/scratch"]

[workspace.package]
edition = "2021"

[workspace.dependencies]
core-types = { path = "crates/core-types" }
serde = "1"
`,
    );
    await write(
      "crates/core-types/Cargo.toml",
      `[package]
name = "core-types"
edition.workspace = true
description = """
Shared types
for the ledger."""

[dependencies]
serde = { workspace = true, optional = true }

[features]
default = []
serde = ["dep:serde"]
`,
    );
    await write("crates/core-types/src/lib.rs", "pub struct Id;\n");
    await write(
      "crates/ledger/Cargo.toml",
      `[package]
name = "ledger"
edition = "2024"
build = "build/main.rs"

[dependencies]
core-types.workspace = true
tokio = { version = "1", features = ["rt"] }

[target.'cfg(unix)'.dependencies]
libc = "0.2"

[dev-dependencies]
ledger-macros = { path = "../macros" }
`,
    );
    await write("crates/ledger/src/lib.rs", "");
    await write("crates/ledger/tests/post.rs", "");
    await write("crates/ledger/tests/close/main.rs", "");
    await write(
      "crates/macros/Cargo.toml",
      `[package]
name = "ledger-macros"
edition = "2021"

[lib]
proc-macro = true
`,
    );
    await write("crates/macros/src/lib.rs", "");
    await write("crates/scratch/Cargo.toml", `[package]\nname = "scratch"\n`);
    await write(
      "tools/cli/Cargo.toml",
      `[package]
name = "ledger-cli"
edition = "2021"

[[bin]]
name = "ledger"
path = "src/main.rs"

[dependencies]
ledger = { path = "../../crates/ledger" }
`,
    );
    await write("tools/cli/src/main.rs", "fn main() {}\n");
    await write("tools/cli/src/bin/admin.rs", "fn main() {}\n");
  }

  test("discovers members, targets, features, and internal edges", async () => {
    await writeWorkspace();

    const workspace = await readRustWorkspace(rootDir);

    expect(workspace?.isWorkspace).toBe(true);
    expect(workspace?.crates.map((crate) => crate.name)).toEqual([
      "core-types",
      "ledger",
      "ledger-macros",
      "ledger-cli",
    ]);
    const [coreTypes, ledger, macros, cli] = workspace?.crates ?? [];
    expect(coreTypes).toMatchObject({
      edition: "2021",
      lib: "crates/core-types/src/lib.rs",
      features: ["serde"],
      defaultFeatures: [],
    });
    expect(ledger).toMatchObject({
      edition: "2024",
      buildScript: "crates/ledger/build/main.rs",
      auxiliaryTargets: { tests: 2, examples: 0, benches: 0 },
    });
    expect(ledger?.dependencies).toEqual([
      {
        name: "core-types",
        kind: "normal",
        optional: false,
        internal: "core-types",
      },
      { name: "tokio", kind: "normal", optional: false },
      { name: "libc", kind: "normal", optional: false },
      {
        name: "ledger-macros",
        kind: "dev",
        optional: false,
        internal: "ledger-macros",
      },
    ]);
    expect(macros?.procMacro).toBe(true);
    expect(cli?.bins).toEqual([
      "ledger (tools/cli/src/main.rs)",
      "admin (tools/cli/src/bin/admin.rs)",
    ]);
  });

  test("renders dependency layers and crate summaries", async () => {
    await writeWorkspace();

    const rendered = renderRustWorkspace((await readRustWorkspace(rootDir))!);

    expect(rendered).toContain("nothing was built or executed");
    expect(rendered).toContain(
      "1. `core-types`, `ledger-macros`\n  2. `ledger`\n  3. `ledger-cli`",
    );
    expect(rendered).toContain("description: Shared types for the ledger.");
    expect(rendered).toContain(
      "depends on workspace crates: `core-types`, `ledger-macros` (dev)",
    );
    expect(rendered).toContain(
      "- `ledger-macros` (crates/macros): proc-macro, edition 2021",
    );
    expect(rendered).not.toContain("scratch");
  });

  test("respects .openwikiignore and tolerates malformed manifests", async () => {
    await writeWorkspace();
    await write("crates/broken/Cargo.toml", "[package\nname = ");

    const workspace = await readRustWorkspace(
      rootDir,
      new OpenWikiIgnore(["tools/"]),
    );

    expect(workspace?.crates.map((crate) => crate.name)).not.toContain(
      "ledger-cli",
    );
    expect(
      workspace?.warnings.some((warning) =>
        warning.startsWith("crates/broken/Cargo.toml"),
      ),
    ).toBe(true);
  });

  test("treats a single-package repository as one crate", async () => {
    await write("Cargo.toml", `[package]\nname = "solo"\nedition = "2021"\n`);
    await write("src/main.rs", "fn main() {}\n");

    const workspace = await readRustWorkspace(rootDir);

    expect(workspace?.isWorkspace).toBe(false);
    expect(workspace?.crates).toHaveLength(1);
    expect(workspace?.crates[0]?.bins).toEqual(["solo (src/main.rs)"]);
  });

  test("produces no planning context outside Rust repositories", async () => {
    await write("package.json", "{}");

    expect(
      await buildRustPlanningContext(rootDir, new OpenWikiIgnore([])),
    ).toBeUndefined();
  });
});
