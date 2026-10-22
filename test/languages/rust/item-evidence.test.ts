import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { OpenWikiIgnore } from "../../../src/agent/openwiki-ignore.ts";
import { EvidenceResourceError } from "../../../src/claims/core/errors.ts";
import {
  formatRepositoryEvidenceResource,
  parseRepositoryEvidenceResource,
} from "../../../src/claims/evidence/repository/resource.ts";
import { RepositoryEvidenceResolver } from "../../../src/claims/evidence/repository/resolver.ts";
import { createListRustItemsTool } from "../../../src/languages/rust/index.ts";

const LEDGER = `pub struct Ledger;

impl Ledger {
    /// Posts one entry.
    pub fn post(&self) -> u32 {
        1
    }

    pub fn close(&self) {}
}

impl std::fmt::Display for Ledger {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "ledger")
    }
}
`;

describe("item evidence resources", () => {
  test("parses and canonicalizes item fragments", () => {
    expect(
      parseRepositoryEvidenceResource(
        "repo://src/ledger.rs#item=Ledger :: post",
      ),
    ).toEqual({ path: "src/ledger.rs", item: "Ledger::post" });
    expect(
      parseRepositoryEvidenceResource(
        "repo://src/ledger.rs#item=%3CLedger%20as%20Display%3E::fmt",
      ),
    ).toEqual({ path: "src/ledger.rs", item: "<Ledger as Display>::fmt" });
  });

  test("formats items readably, encoding only unsafe characters", () => {
    expect(
      formatRepositoryEvidenceResource({
        path: "src/ledger.rs",
        item: "<Ledger as Display>::fmt",
      }),
    ).toBe("repo://src/ledger.rs#item=<Ledger%20as%20Display>::fmt");
  });

  test("rejects items on non-Rust files and malformed item paths", () => {
    expect(() =>
      parseRepositoryEvidenceResource("repo://src/index.ts#item=main"),
    ).toThrow(EvidenceResourceError);
    expect(() =>
      parseRepositoryEvidenceResource("repo://src/ledger.rs#item=::post"),
    ).toThrow(EvidenceResourceError);
    expect(() =>
      formatRepositoryEvidenceResource({
        path: "src/ledger.rs",
        item: "Ledger",
        range: { startLine: 1, endLine: 2 },
      }),
    ).toThrow(EvidenceResourceError);
  });

  test("still parses line ranges unchanged", () => {
    expect(
      parseRepositoryEvidenceResource("repo://src/ledger.rs#L3-L9"),
    ).toEqual({
      path: "src/ledger.rs",
      range: { startLine: 3, endLine: 9 },
    });
  });
});

describe("RepositoryEvidenceResolver with item evidence", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "openwiki-rust-items-"));
  });

  afterEach(async () => {
    await rm(rootDir, { force: true, recursive: true });
  });

  async function writeLedger(content: string): Promise<void> {
    await mkdir(path.join(rootDir, "src"), { recursive: true });
    await writeFile(path.join(rootDir, "src/ledger.rs"), content, "utf8");
  }

  test("returns the canonical resource and the item's exact text", async () => {
    await writeLedger(LEDGER);
    const resolver = new RepositoryEvidenceResolver({ rootDir });

    const resolved = await resolver.resolve(
      "repo://src/ledger.rs#item=Ledger::post",
    );

    expect(resolved?.evidence.resource).toBe(
      "repo://src/ledger.rs#item=Ledger::post",
    );
    expect(resolved?.content).toBe(
      "/// Posts one entry.\n    pub fn post(&self) -> u32 {\n        1\n    }",
    );
  });

  test("stays current across unrelated edits and becomes stale on a real edit", async () => {
    await writeLedger(LEDGER);
    const resolver = new RepositoryEvidenceResolver({ rootDir });
    const resource = "repo://src/ledger.rs#item=Ledger::post";
    const established = await resolver.resolve(resource);

    await writeLedger(
      `use std::fmt;\n\npub const LIMIT: u32 = 9;\n\n${LEDGER.replace(
        "pub fn close(&self) {}",
        "pub fn close(&self) {\n        drop(self);\n    }",
      )}`,
    );
    const afterUnrelated = await resolver.resolve(
      resource,
      established?.evidence.version,
    );
    expect(afterUnrelated?.evidence.version).toBe(
      established?.evidence.version,
    );

    await writeLedger(LEDGER.replace("        1\n", "        2\n"));
    const afterEdit = await resolver.resolve(
      resource,
      established?.evidence.version,
    );
    expect(afterEdit?.evidence.version).not.toBe(established?.evidence.version);
  });

  test("reports a deleted item as unresolved", async () => {
    await writeLedger(LEDGER);
    const resolver = new RepositoryEvidenceResolver({ rootDir });

    await writeLedger(LEDGER.replace("    pub fn close(&self) {}\n", ""));

    expect(
      await resolver.resolve("repo://src/ledger.rs#item=Ledger::close"),
    ).toBeNull();
  });
});

describe("list_rust_items tool", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "openwiki-rust-tool-"));
    await mkdir(path.join(rootDir, "src"), { recursive: true });
    await writeFile(path.join(rootDir, "src/ledger.rs"), LEDGER, "utf8");
    await writeFile(
      path.join(rootDir, "src/secret.rs"),
      "fn hidden() {}\n",
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(rootDir, { force: true, recursive: true });
  });

  test("lists items with spans for virtual and repository paths", async () => {
    const tool = createListRustItemsTool(rootDir, new OpenWikiIgnore([]));

    const fromVirtual: unknown = await tool.invoke({ path: "/src/ledger.rs" });
    const fromRepo: unknown = await tool.invoke({
      path: "repo://src/ledger.rs#L1-L2",
    });

    expect(fromVirtual).toBe(fromRepo);
    expect(fromVirtual).toContain("L4-L7 function Ledger::post");
    expect(fromVirtual).toContain("<Ledger as Display>::fmt");
  });

  test("refuses ignored, non-Rust, and escaping paths", async () => {
    const tool = createListRustItemsTool(
      rootDir,
      new OpenWikiIgnore(["src/secret.rs"]),
    );

    expect(await tool.invoke({ path: "src/secret.rs" })).toContain(
      ".openwikiignore",
    );
    expect(await tool.invoke({ path: "Cargo.toml" })).toContain("failed");
    expect(await tool.invoke({ path: "../outside.rs" })).toContain("failed");
  });
});
