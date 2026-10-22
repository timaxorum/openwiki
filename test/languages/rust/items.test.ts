import { describe, expect, test } from "vitest";
import { canonicalizeRustItemPath } from "../../../src/languages/rust/item-path.ts";
import {
  listRustItems,
  resolveRustItem,
  RUST_ITEM_VERSION_PREFIX,
} from "../../../src/languages/rust/items.ts";

const SOURCE = `//! Crate docs are not attached to any item.
use std::fmt;

/// A double-entry ledger.
#[derive(Debug)]
pub struct Ledger<T> {
    pub name: String,
    total: T,
}

// An ordinary comment is not part of the item.
impl<T> Ledger<T> {
    /// Posts one entry.
    pub fn post(&mut self) {}
}

impl fmt::Display for Ledger<u8> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ledger")
    }
}

impl From<u8> for Ledger<u8> {
    fn from(_: u8) -> Self {
        todo!()
    }
}

impl From<u16> for Ledger<u16> {
    fn from(_: u16) -> Self {
        todo!()
    }
}

unsafe impl Send for &Ledger<u8> {}
impl !Sync for Ledger<u16> {}

pub enum Error {
    NotFound,
    Io(std::io::Error),
}

mod store {
    pub(crate) fn open() {
        fn helper() {}
    }

    pub trait Backend {
        type Handle;
        const LIMIT: usize;
        fn read(&self) -> Self::Handle;
    }
}

#[cfg(unix)]
fn platform() {}

#[cfg(windows)]
fn platform() {}

macro_rules! entry {
    () => {};
}
`;

describe("listRustItems", () => {
  test("names items relative to the file", async () => {
    const paths = (await listRustItems(SOURCE)).map((item) => item.path);

    expect(paths).toEqual([
      "Ledger",
      "Ledger.name",
      "Ledger.total",
      "impl Ledger",
      "Ledger::post",
      "<Ledger as Display>",
      "<Ledger as Display>::fmt",
      "<Ledger as From<u8>>",
      "<Ledger as From<u8>>::from",
      "<Ledger as From<u16>>",
      "<Ledger as From<u16>>::from",
      "<Ledger as Send>",
      "<Ledger as !Sync>",
      "Error",
      "Error::NotFound",
      "Error::Io",
      "store",
      "store::open",
      "store::Backend",
      "store::Backend::Handle",
      "store::Backend::LIMIT",
      "store::Backend::read",
      "platform",
      "platform",
      "entry",
    ]);
  });

  test("includes outer doc comments and attributes but not plain comments", async () => {
    const items = await listRustItems(SOURCE);
    const ledger = items.find((item) => item.path === "Ledger");
    const inherent = items.find((item) => item.path === "impl Ledger");

    expect(
      ledger?.text.startsWith("/// A double-entry ledger.\n#[derive(Debug)]"),
    ).toBe(true);
    expect(ledger?.startLine).toBe(4);
    expect(inherent?.text.startsWith("impl<T> Ledger<T>")).toBe(true);
  });

  test("addresses raw identifiers without their r# prefix", async () => {
    const items = await listRustItems(
      "struct Reader;\nimpl Reader {\n    fn r#async(&self) {}\n}\n",
    );

    expect(items.map((item) => item.path)).toContain("Reader::async");
    expect(
      (
        await resolveRustItem(
          "struct Reader;\nimpl Reader {\n    fn r#async(&self) {}\n}\n",
          "Reader::async",
        )
      )?.items,
    ).toHaveLength(1);
  });

  test("lists only paths that canonicalize to themselves and resolve", async () => {
    const source = `${SOURCE}
impl IntoResponse for () {}
impl IntoResponse for [u8] {}
impl<R> IntoResponse for (StatusCode, R) {}
impl<K, V, const N: usize> IntoResponse for [(K, V); N] {}
`;
    const items = await listRustItems(source);

    expect(items.map((item) => item.path)).toEqual(
      expect.arrayContaining([
        "<() as IntoResponse>",
        "<[u8] as IntoResponse>",
        "<(StatusCode,R) as IntoResponse>",
        "<[(K,V);N] as IntoResponse>",
      ]),
    );
    for (const item of items) {
      expect(canonicalizeRustItemPath(item.path)).toBe(item.path);
      expect(await resolveRustItem(source, item.path)).not.toBeNull();
    }
  });

  test("does not expose items nested inside function bodies", async () => {
    const paths = (await listRustItems(SOURCE)).map((item) => item.path);

    expect(paths.some((itemPath) => itemPath.includes("helper"))).toBe(false);
  });
});

describe("resolveRustItem", () => {
  test("cites every cfg variant of a duplicated item together", async () => {
    const resolved = await resolveRustItem(SOURCE, "platform");

    expect(resolved?.items).toHaveLength(2);
    expect(resolved?.content).toContain("#[cfg(unix)]");
    expect(resolved?.content).toContain("#[cfg(windows)]");
    expect(resolved?.version.startsWith(RUST_ITEM_VERSION_PREFIX)).toBe(true);
  });

  test("keeps the version when the item moves or is reformatted", async () => {
    const original = await resolveRustItem(SOURCE, "Ledger::post");
    const moved = await resolveRustItem(
      `fn added_above() {}\n\n${SOURCE}`,
      "Ledger::post",
    );
    const reformatted = await resolveRustItem(
      SOURCE.replace(
        "pub fn post(&mut self) {}",
        "pub fn post(\n        &mut self,\n    ) {\n    }",
      ),
      "Ledger::post",
    );

    expect(moved?.version).toBe(original?.version);
    expect(reformatted?.version).toBe(original?.version);
  });

  test("changes the version when the item's tokens change", async () => {
    const original = await resolveRustItem(SOURCE, "<Ledger as Display>::fmt");
    const edited = await resolveRustItem(
      SOURCE.replace('write!(f, "ledger")', 'write!(f, "ledger ")'),
      "<Ledger as Display>::fmt",
    );
    const neighbourEdited = await resolveRustItem(
      SOURCE.replace(
        "pub fn post(&mut self) {}",
        "pub fn post(&mut self) { todo!() }",
      ),
      "<Ledger as Display>::fmt",
    );

    expect(edited?.version).not.toBe(original?.version);
    expect(neighbourEdited?.version).toBe(original?.version);
  });

  test("ignores edits to ordinary comments", async () => {
    const original = await resolveRustItem(SOURCE, "store::open");
    const commented = await resolveRustItem(
      SOURCE.replace(
        "pub(crate) fn open() {",
        "pub(crate) fn open() {\n        // Opens the store. Reworded freely.",
      ),
      "store::open",
    );

    expect(commented?.version).toBe(original?.version);
  });

  test("changes the version when a doc comment or attribute changes", async () => {
    const original = await resolveRustItem(SOURCE, "Ledger");
    const redocumented = await resolveRustItem(
      SOURCE.replace(
        "/// A double-entry ledger.",
        "/// A single-entry ledger.",
      ),
      "Ledger",
    );
    const rederived = await resolveRustItem(
      SOURCE.replace("#[derive(Debug)]", "#[derive(Debug, Clone)]"),
      "Ledger",
    );

    expect(redocumented?.version).not.toBe(original?.version);
    expect(rederived?.version).not.toBe(original?.version);
  });

  test("returns null when the item no longer exists", async () => {
    expect(await resolveRustItem(SOURCE, "Ledger::close")).toBeNull();
  });
});

describe("canonicalizeRustItemPath", () => {
  test.each([
    ["Ledger :: post", "Ledger::post"],
    ["< Ledger  as  Display > :: fmt", "<Ledger as Display>::fmt"],
    ["<Ledger as From< u8 >>", "<Ledger as From<u8>>"],
    ["impl   Ledger", "impl Ledger"],
    ["<Ledger as!Sync>", "<Ledger as !Sync>"],
    ["<( ) as IntoResponse>", "<() as IntoResponse>"],
    ["Reader::r#async", "Reader::async"],
  ])("canonicalizes %j", (input, expected) => {
    expect(canonicalizeRustItemPath(input)).toBe(expected);
  });

  test.each(["", "::post", "Ledger::", "a::::b", "Ledger#post", "a\u0001b"])(
    "rejects %j",
    (input) => {
      expect(canonicalizeRustItemPath(input)).toBeNull();
    },
  );
});
