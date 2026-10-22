import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { OpenWikiIgnore } from "../../agent/openwiki-ignore.js";

/**
 * Maximum crates rendered into planner context.
 */
const MAX_RENDERED_CRATES = 60;

/**
 * Maximum external dependency names listed per crate.
 */
const MAX_EXTERNAL_DEPENDENCIES = 12;

/**
 * Maximum feature names listed per crate.
 */
const MAX_FEATURES = 12;

/**
 * Dependency section a crate edge came from.
 */
export type RustDependencyKind = "normal" | "dev" | "build";

/**
 * One dependency declared by a workspace crate.
 */
export interface RustDependency {
  /**
   * Name used in code (the manifest key).
   */
  name: string;

  /**
   * Section that declared it.
   */
  kind: RustDependencyKind;

  /**
   * Whether it is `optional = true` (enabled through a feature).
   */
  optional: boolean;

  /**
   * Workspace crate name when the dependency is another member.
   */
  internal?: string;
}

/**
 * One crate discovered from Cargo manifests.
 */
export interface RustCrate {
  /**
   * Package name.
   */
  name: string;

  /**
   * Repository-relative crate directory (`.` for the root).
   */
  dir: string;

  /**
   * Package description, when declared.
   */
  description?: string;

  /**
   * Rust edition, resolving `edition.workspace = true`.
   */
  edition?: string;

  /**
   * Library entrypoint, when the crate has a library target.
   */
  lib?: string;

  /**
   * Whether the library is a procedural-macro crate.
   */
  procMacro: boolean;

  /**
   * Binary targets as `name (path)`.
   */
  bins: string[];

  /**
   * Build script path, when present.
   */
  buildScript?: string;

  /**
   * Number of integration tests, examples, and benches discovered.
   */
  auxiliaryTargets: { tests: number; examples: number; benches: number };

  /**
   * Feature names in manifest order, with the default set separately.
   */
  features: string[];

  /**
   * Members of the `default` feature.
   */
  defaultFeatures: string[];

  /**
   * Declared dependencies.
   */
  dependencies: RustDependency[];
}

/**
 * Cargo workspace structure computed purely from manifests.
 */
export interface RustWorkspace {
  /**
   * Discovered crates in stable order.
   */
  crates: RustCrate[];

  /**
   * Whether the root manifest declares `[workspace]`.
   */
  isWorkspace: boolean;

  /**
   * Manifests that could not be read or parsed, with the reason.
   */
  warnings: string[];
}

type TomlTable = Record<string, unknown>;

/**
 * Whether a repository root is a Rust project.
 *
 * @param rootDir - Absolute repository root.
 * @returns Whether a root `Cargo.toml` exists.
 */
export async function isRustRepository(rootDir: string): Promise<boolean> {
  try {
    return (await lstat(path.join(rootDir, "Cargo.toml"))).isFile();
  } catch {
    return false;
  }
}

/**
 * Reads the Cargo workspace from manifests alone.
 *
 * This deliberately does not run `cargo metadata`: Cargo may consult
 * repository configuration such as `build.rustc-wrapper` or a
 * `rust-toolchain.toml`, which can execute or install code. Parsing manifests
 * directly needs no Rust toolchain and runs nothing from the repository.
 *
 * @param rootDir - Absolute repository root.
 * @param openWikiIgnore - Read-boundary rules; ignored manifests are skipped.
 * @returns Workspace structure, or `undefined` when there is no root manifest.
 */
export async function readRustWorkspace(
  rootDir: string,
  openWikiIgnore: OpenWikiIgnore = new OpenWikiIgnore([]),
): Promise<RustWorkspace | undefined> {
  const warnings: string[] = [];
  const root = await readManifest(rootDir, ".", warnings);
  if (!root) {
    return undefined;
  }

  const workspaceTable = asTable(root.workspace);
  const memberDirs = new Set<string>();
  if (asTable(root.package)) {
    memberDirs.add(".");
  }
  if (workspaceTable) {
    const excluded = new Set(
      (
        await expandMemberGlobs(rootDir, asStringArray(workspaceTable.exclude))
      ).map(normalizeDir),
    );
    for (const dir of await expandMemberGlobs(
      rootDir,
      asStringArray(workspaceTable.members),
    )) {
      const normalized = normalizeDir(dir);
      if (!excluded.has(normalized)) {
        memberDirs.add(normalized);
      }
    }
  }

  const manifests = new Map<string, TomlTable>();
  for (const dir of [...memberDirs].sort(compareDirs)) {
    if (openWikiIgnore.ignores(joinRepoPath(dir, "Cargo.toml"))) {
      continue;
    }
    const manifest =
      dir === "." ? root : await readManifest(rootDir, dir, warnings);
    if (manifest && asTable(manifest.package)) {
      manifests.set(dir, manifest);
    }
  }

  const crateByDir = new Map<string, string>();
  for (const [dir, manifest] of manifests) {
    const name = asString(asTable(manifest.package)?.name);
    if (name) {
      crateByDir.set(dir, name);
    }
  }

  const crates: RustCrate[] = [];
  for (const [dir, manifest] of manifests) {
    const name = crateByDir.get(dir);
    if (!name) {
      warnings.push(`${joinRepoPath(dir, "Cargo.toml")}: package has no name`);
      continue;
    }
    crates.push(
      await describeCrate(
        rootDir,
        dir,
        name,
        manifest,
        workspaceTable,
        crateByDir,
      ),
    );
  }

  return { crates, isWorkspace: workspaceTable !== undefined, warnings };
}

/**
 * Renders the workspace as compact planner context.
 *
 * @param workspace - Manifest-derived workspace.
 * @returns Markdown context for the repository planner.
 */
export function renderRustWorkspace(workspace: RustWorkspace): string {
  const { crates } = workspace;
  const layers = internalLayers(crates);
  const dependents = new Map<string, Set<string>>();
  for (const crate of crates) {
    for (const dependency of crate.dependencies) {
      if (dependency.internal && dependency.kind === "normal") {
        const users = dependents.get(dependency.internal) ?? new Set<string>();
        users.add(crate.name);
        dependents.set(dependency.internal, users);
      }
    }
  }

  const lines = [
    `Rust ${workspace.isWorkspace ? "workspace" : "crate"} map (computed by OpenWiki from Cargo.toml files; nothing was built or executed):`,
    `- ${crates.length} crate${crates.length === 1 ? "" : "s"}.`,
  ];
  if (layers.length > 1) {
    lines.push(
      "- Internal dependency layers (each layer depends only on earlier ones):",
      ...layers.map(
        (layer, index) =>
          `  ${index + 1}. ${layer.map((name) => `\`${name}\``).join(", ")}`,
      ),
    );
  }
  lines.push("", "Crates:");

  for (const crate of crates.slice(0, MAX_RENDERED_CRATES)) {
    const kinds = [
      crate.lib ? (crate.procMacro ? "proc-macro" : "lib") : undefined,
      crate.bins.length > 0
        ? `${crate.bins.length} bin${crate.bins.length === 1 ? "" : "s"}`
        : undefined,
    ].filter(Boolean);
    lines.push(
      `- \`${crate.name}\` (${crate.dir === "." ? "repository root" : crate.dir}): ${kinds.join(" + ") || "no lib or bin targets"}${crate.edition ? `, edition ${crate.edition}` : ""}`,
    );
    if (crate.description) {
      lines.push(`  - description: ${crate.description.replace(/\s+/gu, " ")}`);
    }
    const entrypoints = [
      crate.lib ? `lib ${crate.lib}` : undefined,
      ...crate.bins.map((bin) => `bin ${bin}`),
    ].filter(Boolean);
    if (entrypoints.length > 0) {
      lines.push(`  - entrypoints: ${entrypoints.join("; ")}`);
    }
    const { tests, examples, benches } = crate.auxiliaryTargets;
    if (tests + examples + benches > 0) {
      lines.push(
        `  - integration tests: ${tests}, examples: ${examples}, benches: ${benches}`,
      );
    }
    if (crate.buildScript) {
      lines.push(`  - build script: ${crate.buildScript}`);
    }
    if (crate.features.length > 0) {
      const shown = crate.features.slice(0, MAX_FEATURES);
      const more = crate.features.length - shown.length;
      lines.push(
        `  - features: ${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}; default = [${crate.defaultFeatures.join(", ")}]`,
      );
    }
    const internal = formatInternalDependencies(crate.dependencies);
    if (internal) {
      lines.push(`  - depends on workspace crates: ${internal}`);
    }
    const users = [...(dependents.get(crate.name) ?? [])].sort();
    if (users.length > 0) {
      lines.push(
        `  - used by: ${users.map((name) => `\`${name}\``).join(", ")}`,
      );
    }
    const external = [
      ...new Set(
        crate.dependencies
          .filter(
            (dependency) =>
              !dependency.internal && dependency.kind === "normal",
          )
          .map((dependency) => dependency.name),
      ),
    ];
    if (external.length > 0) {
      const shown = external.slice(0, MAX_EXTERNAL_DEPENDENCIES);
      const more = external.length - shown.length;
      lines.push(
        `  - external dependencies (${external.length}): ${shown.join(", ")}${more > 0 ? `, +${more} more` : ""}`,
      );
    }
  }
  if (crates.length > MAX_RENDERED_CRATES) {
    lines.push(
      `- ... ${crates.length - MAX_RENDERED_CRATES} more crates omitted; inspect the workspace Cargo.toml.`,
    );
  }
  if (workspace.warnings.length > 0) {
    lines.push(
      "",
      "Manifest warnings:",
      ...workspace.warnings.slice(0, 10).map((warning) => `- ${warning}`),
    );
  }
  return lines.join("\n");
}

/**
 * Builds one crate description from its manifest and directory layout.
 *
 * @param rootDir - Absolute repository root.
 * @param dir - Repository-relative crate directory.
 * @param name - Package name.
 * @param manifest - Parsed crate manifest.
 * @param workspaceTable - Root `[workspace]` table, for inherited fields.
 * @param crateByDir - Member crate names keyed by directory.
 * @returns Crate description.
 */
async function describeCrate(
  rootDir: string,
  dir: string,
  name: string,
  manifest: TomlTable,
  workspaceTable: TomlTable | undefined,
  crateByDir: Map<string, string>,
): Promise<RustCrate> {
  const pkg = asTable(manifest.package) ?? {};
  const workspacePackage = asTable(workspaceTable?.package);
  const inherited = (field: string): unknown => {
    const value = pkg[field];
    return asTable(value)?.workspace === true
      ? workspacePackage?.[field]
      : value;
  };

  const exists = (relative: string) =>
    fileExists(rootDir, joinRepoPath(dir, relative));

  const libTable = asTable(manifest.lib);
  const libPath =
    asString(libTable?.path) ??
    ((await exists("src/lib.rs")) ? "src/lib.rs" : undefined);

  const binPaths = new Map<string, string>();
  for (const bin of asTableArray(manifest.bin)) {
    const binName = asString(bin.name) ?? name;
    const binPath = joinRepoPath(
      dir,
      asString(bin.path) ??
        ((await exists(`src/bin/${binName}.rs`)) || binName !== name
          ? `src/bin/${binName}.rs`
          : "src/main.rs"),
    );
    binPaths.set(binName, binPath);
  }
  if (pkg.autobins !== false) {
    const declaredPaths = new Set(binPaths.values());
    const mainPath = joinRepoPath(dir, "src/main.rs");
    if (
      (await exists("src/main.rs")) &&
      !declaredPaths.has(mainPath) &&
      !binPaths.has(name)
    ) {
      binPaths.set(name, mainPath);
    }
    for (const auto of await listAutoTargets(
      rootDir,
      joinRepoPath(dir, "src/bin"),
    )) {
      if (!binPaths.has(auto.name) && !declaredPaths.has(auto.path)) {
        binPaths.set(auto.name, auto.path);
      }
    }
  }
  const bins = [...binPaths].map(
    ([binName, binPath]) => `${binName} (${binPath})`,
  );

  const build = pkg.build;
  const buildScript =
    build === false
      ? undefined
      : typeof build === "string"
        ? joinRepoPath(dir, build)
        : (await exists("build.rs"))
          ? joinRepoPath(dir, "build.rs")
          : undefined;

  const featuresTable = asTable(manifest.features) ?? {};
  const features = Object.keys(featuresTable).filter(
    (feature) => feature !== "default",
  );

  const dependencies: RustDependency[] = [];
  const workspaceDependencies = asTable(workspaceTable?.dependencies) ?? {};
  const collect = (table: TomlTable | undefined, kind: RustDependencyKind) => {
    for (const [key, value] of Object.entries(table ?? {})) {
      const spec = asTable(value);
      const inheritedSpec =
        spec?.workspace === true
          ? asTable(workspaceDependencies[key])
          : undefined;
      const specPath = asString(spec?.path);
      const dependencyPath = specPath
        ? joinRepoPath(dir, specPath)
        : asString(inheritedSpec?.path);
      const internal =
        dependencyPath === undefined
          ? undefined
          : crateByDir.get(normalizeDir(dependencyPath));
      dependencies.push({
        name: key,
        kind,
        optional: spec?.optional === true,
        ...(internal ? { internal } : {}),
      });
    }
  };
  const sections: [string, RustDependencyKind][] = [
    ["dependencies", "normal"],
    ["dev-dependencies", "dev"],
    ["build-dependencies", "build"],
  ];
  for (const [section, kind] of sections) {
    collect(asTable(manifest[section]), kind);
    for (const target of Object.values(asTable(manifest.target) ?? {})) {
      collect(asTable(asTable(target)?.[section]), kind);
    }
  }

  return {
    name,
    dir,
    ...optionalString("description", asString(inherited("description"))),
    ...optionalString("edition", asString(inherited("edition"))),
    ...(libPath ? { lib: joinRepoPath(dir, libPath) } : {}),
    procMacro: libTable?.["proc-macro"] === true,
    bins,
    ...(buildScript ? { buildScript } : {}),
    auxiliaryTargets: {
      tests: await countTargets(
        rootDir,
        joinRepoPath(dir, "tests"),
        manifest.test,
      ),
      examples: await countTargets(
        rootDir,
        joinRepoPath(dir, "examples"),
        manifest.example,
      ),
      benches: await countTargets(
        rootDir,
        joinRepoPath(dir, "benches"),
        manifest.bench,
      ),
    },
    features,
    defaultFeatures: asStringArray(featuresTable.default),
    dependencies,
  };
}

/**
 * Orders workspace crates into dependency layers using normal dependencies.
 *
 * @param crates - Workspace crates.
 * @returns Layers of crate names; crates in a cycle are placed in a final layer.
 */
function internalLayers(crates: RustCrate[]): string[][] {
  const remaining = new Map(
    crates.map((crate) => [
      crate.name,
      new Set(
        crate.dependencies
          .filter(
            (dependency) => dependency.kind === "normal" && dependency.internal,
          )
          .map((dependency) => dependency.internal as string)
          .filter((dependency) => dependency !== crate.name),
      ),
    ]),
  );
  const layers: string[][] = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter(([, deps]) => [...deps].every((dep) => !remaining.has(dep)))
      .map(([name]) => name)
      .sort();
    if (ready.length === 0) {
      layers.push([...remaining.keys()].sort());
      break;
    }
    layers.push(ready);
    for (const name of ready) {
      remaining.delete(name);
    }
  }
  return layers;
}

/**
 * Formats internal dependencies, marking dev, build, and optional edges.
 *
 * @param dependencies - Crate dependencies.
 * @returns Comma-separated list, or empty when there are none.
 */
function formatInternalDependencies(dependencies: RustDependency[]): string {
  const edges = new Map<string, RustDependency[]>();
  for (const dependency of dependencies) {
    if (!dependency.internal) continue;
    edges.set(dependency.internal, [
      ...(edges.get(dependency.internal) ?? []),
      dependency,
    ]);
  }
  return [...edges]
    .map(([name, declared]) => {
      const normal = declared.filter((edge) => edge.kind === "normal");
      const notes =
        normal.length > 0
          ? normal.every((edge) => edge.optional)
            ? ["optional"]
            : []
          : [...new Set(declared.map((edge) => edge.kind))];
      return notes.length > 0
        ? `\`${name}\` (${notes.join(", ")})`
        : `\`${name}\``;
    })
    .join(", ");
}

/**
 * Reads and parses one manifest, recording failures as warnings.
 *
 * @param rootDir - Absolute repository root.
 * @param dir - Repository-relative directory.
 * @param warnings - Warning accumulator.
 * @returns Parsed manifest, or `undefined`.
 */
async function readManifest(
  rootDir: string,
  dir: string,
  warnings: string[],
): Promise<TomlTable | undefined> {
  const relative = joinRepoPath(dir, "Cargo.toml");
  const absolute = path.join(rootDir, relative);
  if (!isInside(rootDir, absolute)) {
    warnings.push(`${relative}: outside the repository`);
    return undefined;
  }
  try {
    const metadata = await lstat(absolute);
    if (!metadata.isFile()) {
      return undefined;
    }
    return parseToml(await readFile(absolute, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      warnings.push(
        `${relative}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
      );
    }
    return undefined;
  }
}

/**
 * Expands workspace member globs. Supports `*` and `?` within path segments,
 * which covers Cargo's documented usage.
 *
 * @param rootDir - Absolute repository root.
 * @param patterns - Member or exclude patterns.
 * @returns Matching repository-relative directories.
 */
async function expandMemberGlobs(
  rootDir: string,
  patterns: string[],
): Promise<string[]> {
  const results: string[] = [];
  for (const pattern of patterns) {
    let candidates = ["."];
    for (const segment of normalizeDir(pattern)
      .split("/")
      .filter((part) => part !== ".")) {
      const next: string[] = [];
      for (const base of candidates) {
        if (!/[*?[]/u.test(segment)) {
          next.push(joinRepoPath(base, segment));
          continue;
        }
        const matcher = segmentMatcher(segment);
        for (const entry of await listDirectories(rootDir, base)) {
          if (matcher.test(entry)) {
            next.push(joinRepoPath(base, entry));
          }
        }
      }
      candidates = next;
    }
    for (const candidate of candidates) {
      if (isInside(rootDir, path.join(rootDir, candidate))) {
        results.push(candidate);
      }
    }
  }
  return results;
}

/**
 * Compiles one glob path segment.
 *
 * @param segment - Segment containing `*`, `?`, or a bracket class.
 * @returns Anchored matcher.
 */
function segmentMatcher(segment: string): RegExp {
  const source = segment
    .split("")
    .map((character) =>
      character === "*"
        ? "[^/]*"
        : character === "?"
          ? "[^/]"
          : character === "[" || character === "]"
            ? character
            : character.replace(/[.*+?^${}()|\\]/gu, "\\$&"),
    )
    .join("");
  return new RegExp(`^${source}$`, "u");
}

/**
 * Lists real (non-symlink) subdirectories, hiding dot-directories.
 *
 * @param rootDir - Absolute repository root.
 * @param dir - Repository-relative directory.
 * @returns Directory names.
 */
async function listDirectories(
  rootDir: string,
  dir: string,
): Promise<string[]> {
  try {
    const entries = await readdir(path.join(rootDir, dir), {
      withFileTypes: true,
    });
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Lists Cargo's auto-discovered targets in a directory: `name.rs` files and
 * `name/main.rs` subdirectories.
 *
 * @param rootDir - Absolute repository root.
 * @param dir - Repository-relative target directory.
 * @returns Target names and repository-relative paths.
 */
async function listAutoTargets(
  rootDir: string,
  dir: string,
): Promise<{ name: string; path: string }[]> {
  let entries;
  try {
    entries = await readdir(path.join(rootDir, dir), { withFileTypes: true });
  } catch {
    return [];
  }
  const targets: { name: string; path: string }[] = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".rs")) {
      targets.push({
        name: entry.name.slice(0, -3),
        path: joinRepoPath(dir, entry.name),
      });
    } else if (
      entry.isDirectory() &&
      (await fileExists(rootDir, joinRepoPath(dir, `${entry.name}/main.rs`)))
    ) {
      targets.push({
        name: entry.name,
        path: joinRepoPath(dir, `${entry.name}/main.rs`),
      });
    }
  }
  return targets.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Counts auto-discovered plus explicitly declared auxiliary targets.
 *
 * @param rootDir - Absolute repository root.
 * @param dir - Repository-relative target directory.
 * @param declared - Manifest array of explicit targets.
 * @returns Number of distinct targets.
 */
async function countTargets(
  rootDir: string,
  dir: string,
  declared: unknown,
): Promise<number> {
  const names = new Set(
    (await listAutoTargets(rootDir, dir)).map((target) => target.name),
  );
  for (const target of asTableArray(declared)) {
    const name = asString(target.name);
    if (name) names.add(name);
  }
  return names.size;
}

/**
 * Whether a repository-relative path is a regular file.
 *
 * @param rootDir - Absolute repository root.
 * @param relative - Repository-relative path.
 * @returns Whether it exists as a regular file.
 */
async function fileExists(rootDir: string, relative: string): Promise<boolean> {
  try {
    return (await lstat(path.join(rootDir, relative))).isFile();
  } catch {
    return false;
  }
}

function isInside(rootDir: string, candidate: string): boolean {
  const relative = path.relative(
    path.resolve(rootDir),
    path.resolve(candidate),
  );
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function joinRepoPath(dir: string, relative: string): string {
  return normalizeDir(path.posix.join(dir, relative.replace(/\\/gu, "/")));
}

function normalizeDir(dir: string): string {
  const normalized = path.posix
    .normalize(dir.replace(/\\/gu, "/"))
    .replace(/\/+$/u, "");
  return normalized === "" ? "." : normalized.replace(/^\.\//u, "");
}

function compareDirs(left: string, right: string): number {
  return left === "." ? -1 : right === "." ? 1 : left.localeCompare(right);
}

function asTable(value: unknown): TomlTable | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as TomlTable)
    : undefined;
}

function asTableArray(value: unknown): TomlTable[] {
  return Array.isArray(value)
    ? value
        .map(asTable)
        .filter((table): table is TomlTable => table !== undefined)
    : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function optionalString<Key extends string>(
  key: Key,
  value: string | undefined,
): Partial<Record<Key, string>> {
  return value === undefined ? {} : ({ [key]: value } as Record<Key, string>);
}
