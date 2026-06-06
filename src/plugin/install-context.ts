/**
 * Detect HOW reponova is installed and WHICH package manager to use.
 *
 * Replaces the old `parent(node_modules)`-heuristic with a multi-signal
 * detection that covers:
 *   • global installs (npm, yarn classic, pnpm) — via `global-directory`
 *     plus a manual pnpm fallback (the v4 we depend on for Node 18
 *     compatibility predates pnpm support)
 *   • npx temporary cache (aborts cleanly instead of polluting the cache)
 *   • local project installs — by walking up to the first real consumer
 *     `package.json` and reading the lockfile / `packageManager` field
 *   • `npm link` / development mode — skips package-manager calls so we
 *     don't accidentally mutate reponova's own devDependencies
 *
 * All file-system paths are canonicalized via `realpathSync` before any
 * comparison, so symlinked layouts (nvm, fnm, Homebrew Cellar, npm link)
 * are matched correctly. Comparisons are case-insensitive on Windows.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import globalDirectory from "global-directory";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/**
 * Outcome of detection. Consumers should switch on `kind`:
 *  • `global`  → run e.g. `pm add -g <pkg>` (no cwd, system-wide)
 *  • `local`   → run e.g. `pm add <pkg>` with cwd = projectRoot
 *  • `linked`  → reponova is not installed via a package manager
 *               (dev tree / `npm link`); do NOT call any PM — assume the
 *               plugin is already reachable, just mutate config
 *  • `abort`   → context is incompatible (npx cache, exotic layout);
 *               surface `reason` + `hint` to the user and exit
 */
export type InstallContext =
  | { kind: "global"; packageManager: PackageManager; viaDir: string }
  | { kind: "local"; projectRoot: string; packageManager: PackageManager }
  | { kind: "linked"; reponovaDir: string }
  | { kind: "abort"; reason: string; hint: string };

/**
 * Detect the install context for the currently executing reponova.
 *
 * `reponovaDirHint` lets callers (and tests) override the starting
 * directory. When omitted, it is derived from this module's URL.
 */
export function detectInstallContext(reponovaDirHint?: string): InstallContext {
  const rawDir = reponovaDirHint ?? fileURLToPath(new URL(".", import.meta.url));
  const reponovaPkgDir = findOwningPackageDir(rawDir, "reponova") ?? canonicalize(rawDir);

  // 1. npx temp cache — never install plugins here (evicted, also non-resolvable).
  if (containsSegment(reponovaPkgDir, "_npx")) {
    return {
      kind: "abort",
      reason: `reponova is running from an npx cache (${reponovaPkgDir}).`,
      hint:
        "Language plugins require a persistent install of reponova. Choose one:\n" +
        "  Globally:    npm i -g reponova   (or: pnpm add -g / yarn global add)\n" +
        "  Per-project: npm i -D reponova   (then re-run `npx reponova lang add ...`)\n" +
        "Then re-run `reponova lang add <plugin>`.",
    };
  }

  // 2. Global install — match against each PM's global packages dir.
  const globalMatch = matchGlobalDir(reponovaPkgDir);
  if (globalMatch) {
    return { kind: "global", packageManager: globalMatch.pm, viaDir: globalMatch.dir };
  }

  // 3. Local install — reponova lives inside a `node_modules/` belonging
  //    to a real consumer package.
  const local = matchLocalProject(reponovaPkgDir);
  if (local) return local;

  // 4. Fallback: reponova is reachable but not via any PM we recognise.
  //    Most common case: a dev checkout / `npm link`. We must NOT call any
  //    package manager (it would mutate reponova's own devDependencies),
  //    but the caller can still update YAML config and load already-linked
  //    plugins from `node_modules/`.
  return { kind: "linked", reponovaDir: reponovaPkgDir };
}

// ─── Global match ────────────────────────────────────────────────────────────

function matchGlobalDir(
  reponovaPkgDir: string,
): { pm: PackageManager; dir: string } | null {
  for (const candidate of globalCandidates()) {
    if (!candidate.dir) continue;
    const dir = canonicalize(candidate.dir);
    if (isPathInside(reponovaPkgDir, dir)) {
      return { pm: candidate.pm, dir };
    }
  }
  return null;
}

/**
 * Yield each candidate global packages directory. Order matters: more
 * specific matchers (pnpm, yarn) come before the generic npm prefix so
 * that overlapping layouts resolve to the correct PM. The final
 * `execPath`-derived fallback catches version managers (fnm, nvm,
 * Volta, asdf, Homebrew Cellar) whose layouts aren't hardcoded into
 * `global-directory@4`.
 */
function* globalCandidates(): Generator<{ pm: PackageManager; dir: string | null }> {
  yield { pm: "pnpm", dir: getPnpmGlobalPackagesDir() };
  yield { pm: "yarn", dir: globalDirectory.yarn?.packages ?? null };
  yield { pm: "npm", dir: globalDirectory.npm?.packages ?? null };
  yield { pm: "npm", dir: getExecPathGlobalDir() };
}

/**
 * Global packages dir derived from `process.execPath`. Universal fallback
 * for version managers that bypass the conventional npm prefix locations.
 *
 * Layouts handled:
 *   • Windows (fnm, nvm-windows): `<install>/node.exe`         → `<install>/node_modules`
 *   • POSIX   (nvm, asdf, Volta, system): `<prefix>/bin/node`  → `<prefix>/lib/node_modules`
 *   • Homebrew Cellar: same POSIX rule (Cellar puts node under `<cellar>/bin/node`)
 *
 * Cheap to compute and based on the Node process actually running reponova,
 * so it's correct even when the user's `npm prefix -g` is misconfigured.
 */
function getExecPathGlobalDir(): string | null {
  try {
    const exec = process.execPath;
    if (!exec) return null;
    if (platform() === "win32") {
      return join(dirname(exec), "node_modules");
    }
    return join(dirname(dirname(exec)), "lib", "node_modules");
  } catch {
    return null;
  }
}

/**
 * pnpm global root. Replicates the logic of `global-directory@5` for pnpm
 * (we depend on v4 for Node 18 compatibility).
 *
 * Honours: `PNPM_HOME`, `XDG_DATA_HOME`, then platform-specific defaults.
 */
function getPnpmGlobalPackagesDir(): string | null {
  let dataDir: string | null = null;

  if (process.env.PNPM_HOME) {
    dataDir = process.env.PNPM_HOME;
  } else if (process.env.XDG_DATA_HOME) {
    dataDir = join(process.env.XDG_DATA_HOME, "pnpm");
  } else if (platform() === "darwin") {
    dataDir = join(homedir(), "Library", "pnpm");
  } else if (platform() === "win32") {
    dataDir = process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, "pnpm")
      : join(homedir(), ".pnpm");
  } else {
    dataDir = join(homedir(), ".local", "share", "pnpm");
  }

  if (!dataDir) return null;
  // pnpm v7+ keeps globals under `<data>/global/5/node_modules`. The major
  // version segment may bump in the future; we match the parent dir which
  // is stable, so an exact match isn't required.
  return resolve(dataDir, "global");
}

// ─── Local match ─────────────────────────────────────────────────────────────

function matchLocalProject(reponovaPkgDir: string): InstallContext | null {
  // Walk up looking for the FIRST `node_modules/` ancestor. The directory
  // immediately above is a candidate project root.
  const segments = reponovaPkgDir.split(sep);
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i] !== "node_modules") continue;

    const projectRoot = canonicalize(segments.slice(0, i).join(sep) || sep);
    if (!isRealConsumerProject(projectRoot)) continue;

    return {
      kind: "local",
      projectRoot,
      packageManager: detectPackageManager(projectRoot),
    };
  }
  return null;
}

/**
 * A "real consumer project" is any directory holding a `package.json`
 * that isn't reponova's own and that looks like an app/library (declares
 * dependencies, workspaces, or a `packageManager` field, or has a lockfile).
 *
 * This filters out spurious matches like nested `node_modules` from
 * partial hoisting where the parent dir is itself another package's
 * private folder.
 */
function isRealConsumerProject(dir: string): boolean {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    if (pkg.name === "reponova") return false;
    const hasDeps =
      isNonEmptyObject(pkg.dependencies) ||
      isNonEmptyObject(pkg.devDependencies) ||
      isNonEmptyObject(pkg.peerDependencies) ||
      isNonEmptyObject(pkg.optionalDependencies);
    if (hasDeps) return true;
    if (pkg.workspaces) return true;
    if (typeof pkg.packageManager === "string") return true;
    return hasAnyLockfile(dir);
  } catch {
    return false;
  }
}

function isNonEmptyObject(value: unknown): boolean {
  return !!value && typeof value === "object" && Object.keys(value as object).length > 0;
}

// ─── Package manager detection ───────────────────────────────────────────────

/**
 * Determine which PM owns a project root. Order (highest priority first):
 *   1. `packageManager` field in package.json (Corepack-aware, official source)
 *   2. Lockfile presence
 *   3. Default: npm
 */
export function detectPackageManager(projectRoot: string): PackageManager {
  const fromField = readPackageManagerField(projectRoot);
  if (fromField) return fromField;
  return detectPackageManagerFromLockfile(projectRoot) ?? "npm";
}

function readPackageManagerField(projectRoot: string): PackageManager | null {
  try {
    const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf-8"));
    const raw = pkg.packageManager;
    if (typeof raw !== "string") return null;
    const name = raw.split("@", 1)[0]?.toLowerCase();
    if (name === "npm" || name === "pnpm" || name === "yarn" || name === "bun") {
      return name;
    }
    return null;
  } catch {
    return null;
  }
}

function detectPackageManagerFromLockfile(projectRoot: string): PackageManager | null {
  if (existsSync(join(projectRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(projectRoot, "yarn.lock"))) return "yarn";
  if (existsSync(join(projectRoot, "bun.lockb"))) return "bun";
  if (existsSync(join(projectRoot, "bun.lock"))) return "bun";
  if (existsSync(join(projectRoot, "package-lock.json"))) return "npm";
  if (existsSync(join(projectRoot, "npm-shrinkwrap.json"))) return "npm";
  return null;
}

function hasAnyLockfile(projectRoot: string): boolean {
  return detectPackageManagerFromLockfile(projectRoot) !== null;
}

// ─── Command builders ────────────────────────────────────────────────────────

/**
 * Build the argv-style command to run for installing / removing `packageName`
 * under the given context. Returns `null` for `linked`/`abort` kinds — the
 * caller decides whether to skip silently or surface the abort reason.
 */
export function buildInstallCommand(
  packageName: string,
  ctx: InstallContext,
): { argv: [string, ...string[]]; cwd?: string } | null {
  if (ctx.kind === "linked" || ctx.kind === "abort") return null;
  const pm = ctx.packageManager;
  const isGlobal = ctx.kind === "global";

  const argv = buildPmArgs(pm, "add", packageName, isGlobal);
  return isGlobal ? { argv } : { argv, cwd: ctx.projectRoot };
}

export function buildUninstallCommand(
  packageName: string,
  ctx: InstallContext,
): { argv: [string, ...string[]]; cwd?: string } | null {
  if (ctx.kind === "linked" || ctx.kind === "abort") return null;
  const pm = ctx.packageManager;
  const isGlobal = ctx.kind === "global";

  const argv = buildPmArgs(pm, "remove", packageName, isGlobal);
  return isGlobal ? { argv } : { argv, cwd: ctx.projectRoot };
}

function buildPmArgs(
  pm: PackageManager,
  op: "add" | "remove",
  pkg: string,
  isGlobal: boolean,
): [string, ...string[]] {
  switch (pm) {
    case "npm":
      return op === "add"
        ? ["npm", "install", ...(isGlobal ? ["-g"] : []), pkg]
        : ["npm", "uninstall", ...(isGlobal ? ["-g"] : []), pkg];
    case "pnpm":
      return op === "add"
        ? ["pnpm", "add", ...(isGlobal ? ["-g"] : []), pkg]
        : ["pnpm", "remove", ...(isGlobal ? ["-g"] : []), pkg];
    case "yarn":
      // Yarn classic: `global add` vs `add`. Yarn berry: `add` is the same
      // for both (no concept of global), but we still emit `global add` —
      // berry will surface a clear error which is better than silently
      // mutating the wrong project.
      if (isGlobal) {
        return op === "add" ? ["yarn", "global", "add", pkg] : ["yarn", "global", "remove", pkg];
      }
      return op === "add" ? ["yarn", "add", pkg] : ["yarn", "remove", pkg];
    case "bun":
      return op === "add"
        ? ["bun", "add", ...(isGlobal ? ["-g"] : []), pkg]
        : ["bun", "remove", ...(isGlobal ? ["-g"] : []), pkg];
  }
}

// ─── Path utilities ──────────────────────────────────────────────────────────

/**
 * `realpathSync` + normalisation. Returns the input verbatim when realpath
 * fails (e.g. path doesn't exist yet — we still want a usable string).
 */
function canonicalize(p: string): string {
  if (!p) return p;
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * True when `child` is `parent` itself or a descendant of `parent`.
 * Case-insensitive on Windows. Both inputs are expected to be canonical
 * absolute paths.
 */
function isPathInside(child: string, parent: string): boolean {
  if (!isAbsolute(child) || !isAbsolute(parent)) return false;
  const norm = (s: string): string => {
    const trimmed = s.endsWith(sep) ? s.slice(0, -1) : s;
    return platform() === "win32" ? trimmed.toLowerCase() : trimmed;
  };
  const c = norm(child);
  const p = norm(parent);
  if (c === p) return true;
  return c.startsWith(p + (platform() === "win32" ? sep.toLowerCase() : sep));
}

function containsSegment(p: string, segment: string): boolean {
  const target = platform() === "win32" ? segment.toLowerCase() : segment;
  return p
    .split(sep)
    .map((s) => (platform() === "win32" ? s.toLowerCase() : s))
    .includes(target);
}

/**
 * Walk up from `startDir` looking for a `package.json` whose `name` field
 * equals `expectedName`. Returns the directory containing it, or `null`.
 */
function findOwningPackageDir(startDir: string, expectedName: string): string | null {
  let dir = canonicalize(startDir);
  for (let i = 0; i < 12; i++) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (pkg.name === expectedName) return dir;
      } catch {
        // ignore parse errors, keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

// ─── User-facing formatting ──────────────────────────────────────────────────

/**
 * Pretty-print an `abort` context for the user. Caller decides between
 * stderr/stdout and exit code.
 */
export function formatAbort(ctx: Extract<InstallContext, { kind: "abort" }>): string {
  return `${ctx.reason}\n\n${ctx.hint}`;
}

/**
 * Short, single-line description for logs (e.g. "global (pnpm)").
 */
export function describeContext(ctx: InstallContext): string {
  switch (ctx.kind) {
    case "global":
      return `global (${ctx.packageManager})`;
    case "local":
      return `local: ${ctx.projectRoot} (${ctx.packageManager})`;
    case "linked":
      return `linked: ${ctx.reponovaDir} (dev / npm link — package manager calls skipped)`;
    case "abort":
      return `abort: ${ctx.reason}`;
  }
}
