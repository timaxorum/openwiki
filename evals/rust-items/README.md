# Rust language pack: prototype notes

This branch adds a Rust language pack to OpenWiki without building or running
anything from the documented repository. It has three parts:

1. **Crate map for the planner** (`src/languages/rust/workspace.ts`). The
   workspace members, internal dependency layers, lib/bin entrypoints, build
   scripts, proc-macro crates, features and external dependencies, read
   directly from `Cargo.toml` files. The map is appended to the planner prompt
   with a short guide to planning around crates.
2. **Item-anchored evidence** (`src/languages/rust/items.ts`). Claims can cite
   `repo://src/ledger.rs#item=Ledger::post` instead of `#L40-L82`. The
   resolver finds the item by name wherever it sits in the file. Its version is
   a fingerprint of the item's syntax tokens, so the claim goes stale only
   when the item itself changes.
3. **Worker support** (`src/languages/rust/index.ts`). This is guidance on item
   paths and Rust-specific substance (unsafe/SAFETY invariants, Send/Sync,
   error propagation, panics, feature/cfg differences, async runtime), plus a
   read-only `list_rust_items` tool that returns each item's path and line span.

All three switch on only when the repository root has a `Cargo.toml`. Other
repositories get exactly the prompts and tools they had before.

## Why manifests and not `cargo metadata`

`cargo metadata` is the obvious source, but Cargo reads repository
configuration (`.cargo/config.toml` can set `build.rustc` or
`build.rustc-wrapper`). Through rustup, a `rust-toolchain.toml` can also
trigger a toolchain install. Either one can run or install code, which cuts
against OpenWiki's lockdown of host commands (#888). Parsing `Cargo.toml` with
`smol-toml` needs no Rust toolchain in CI and runs nothing. What we lose is
resolved versions and the external dependency graph, and the planner doesn't
need either.

The parser is tree-sitter's Rust grammar, loaded from its prebuilt
WebAssembly. Its native build script is disabled in `pnpm-workspace.yaml`.

## Item paths

Paths are relative to the file, not the crate. That way they can be computed
without resolving modules or building anything.

| Source                            | Item path                                         |
| --------------------------------- | ------------------------------------------------- |
| `fn open()`                       | `open`                                            |
| `struct Ledger`                   | `Ledger`                                          |
| field `total`                     | `Ledger.total`                                    |
| `enum Error { NotFound }`         | `Error::NotFound`                                 |
| `impl<T> Ledger<T> { fn post() }` | `Ledger::post`; the block itself is `impl Ledger` |
| `impl fmt::Display for Ledger`    | `<Ledger as Display>`, `<Ledger as Display>::fmt` |
| `impl From<u8> for Ledger`        | `<Ledger as From<u8>>`                            |
| `mod store { fn open() }`         | `store::open`                                     |
| `trait Backend { type Handle; }`  | `Backend::Handle`                                 |

- Generic parameters on the self type are dropped. Trait arguments are kept,
  so `From<u8>` and `From<u16>` stay distinct.
- Fields use `.` because getters usually share the field's name.
- Items declared inside function bodies can't be addressed. Use a line range
  for those.
- When several definitions share a path (`#[cfg(unix)]` and `#[cfg(windows)]`
  variants, or a function and a module with the same name), the evidence cites
  all of them together.

What changes the version:

- Whitespace, trailing commas, and the text of ordinary `//` and `/* */`
  comments are ignored.
- Every other token counts, including literals, attributes such as `#[cfg]`
  and `#[derive]`, and doc comments.

## Replaying real history

`evals/rust-items/replay.ts` replays a repository's history to compare line
ranges with item anchors:

1. It walks the commits that modify `.rs` files.
2. At each parent commit, it cites every function and type in each modified
   file twice:
   - as a line range covering exactly that item. That's the best case for line
     ranges; models usually cite tighter or sloppier spans.
   - as an item.
3. At the child commit it re-resolves both with their prior versions, exactly
   as Claims preflight does.
4. It checks both verdicts against what actually happened to the item's text.

```
pnpm exec tsx evals/rust-items/replay.ts <path-to-rust-repo> [commits=300]
```

Results on the most recent commits that touch Rust in three repositories:

RESULTS_TABLE

How to read the table:

- **Unchanged items:** both anchors are almost always right. OpenWiki's
  existing line-range relocation is already good at following code that only
  moved.
- **Edited items:** this is where they differ. A line range often can't find
  its anchors after the edit, so the claim is reported _unresolved_ (the
  evidence is gone) instead of _stale_ (the evidence changed). Either verdict
  makes the worker recheck, but an unresolved claim has lost its pointer to
  the code. Item evidence still resolves to the new text of the same item.
- **Line ranges that miss edits:** sometimes a line range reports _current_
  even though the item changed. Typically an attribute or doc comment was
  added, or the item grew, and the old lines still match.
- **Item evidence can't follow** an item that is renamed or moved to another
  file. That counts as removed for both anchors.

## Known limits and next steps

- **Host-driven path.** Only the native runner (`openwiki init`/`update`) gets
  the crate map, the guidance and `list_rust_items`. Hosts that drive the
  lifecycle over MCP (Claude Code, Codex and others) still accept and verify
  item evidence, but their skill text doesn't mention it yet.
- **Update scoping** is still by changed path. The next step is to diff item
  fingerprints between baselines so the planner sees which items changed, and
  to use the crate layers to flag pages about dependent crates when a crate's
  public items change.
- **No type information.** A claim like "this handle is `Send`" can cite an
  explicit `unsafe impl Send`, but not an auto-trait the compiler infers.
  That needs rustdoc JSON or rust-analyzer, which means building. It belongs
  behind an explicit opt-in.
- **No model-in-the-loop measurement yet.** The replay measures resolution,
  not whether models cite items more accurately than line numbers. That needs
  a real `openwiki init` with a model on a Rust repository.
