/**
 * Unit tests for `planRemoveAction` — the pure decision matrix that
 * decides what `reponova lang remove` should do given the install
 * context, CLI flags, and TTY availability.
 *
 * Covers every branch of the matrix so that future changes to the
 * policy are caught by a single, deterministic test file.
 */
import { describe, it, expect } from "vitest";
import { planRemoveAction, type RemoveOptions } from "../src/cli/lang.js";
import type { InstallContext } from "../src/plugin/install-context.js";

const linked: InstallContext = { kind: "linked", reponovaDir: "/dev/reponova" };
const local: InstallContext = {
  kind: "local",
  projectRoot: "/p",
  packageManager: "pnpm",
};
const global_: InstallContext = {
  kind: "global",
  packageManager: "npm",
  viaDir: "/usr/local/lib/node_modules",
};
const abort: InstallContext = {
  kind: "abort",
  reason: "npx cache",
  hint: "install reponova first",
};

function plan(
  ctx: InstallContext,
  opts: RemoveOptions,
  env: { isInteractive: boolean; packageInstalled: boolean },
) {
  return planRemoveAction(ctx, opts, env);
}

describe("planRemoveAction — --config-only wins over everything", () => {
  it("returns config-only(flag) even when local + interactive + installed", () => {
    expect(plan(local, { configOnly: true }, { isInteractive: true, packageInstalled: true }))
      .toEqual({ kind: "config-only", reason: "flag" });
  });
  it("returns config-only(flag) even when global + purgeGlobal", () => {
    expect(plan(global_, { configOnly: true, purgeGlobal: true }, { isInteractive: true, packageInstalled: true }))
      .toEqual({ kind: "config-only", reason: "flag" });
  });
});

describe("planRemoveAction — package not installed → config-only(missing-pkg)", () => {
  it("on local context", () => {
    expect(plan(local, {}, { isInteractive: true, packageInstalled: false }))
      .toEqual({ kind: "config-only", reason: "missing-pkg" });
  });
  it("on global context (even with --purge-global)", () => {
    expect(plan(global_, { purgeGlobal: true }, { isInteractive: true, packageInstalled: false }))
      .toEqual({ kind: "config-only", reason: "missing-pkg" });
  });
});

describe("planRemoveAction — linked context never touches the PM", () => {
  it("returns config-only(linked) with interactive=true and package installed", () => {
    expect(plan(linked, {}, { isInteractive: true, packageInstalled: true }))
      .toEqual({ kind: "config-only", reason: "linked" });
  });
});

describe("planRemoveAction — abort context falls back to config-only", () => {
  it("returns config-only(abort)", () => {
    expect(plan(abort, {}, { isInteractive: true, packageInstalled: true }))
      .toEqual({ kind: "config-only", reason: "abort" });
  });
});

describe("planRemoveAction — local context always uninstalls", () => {
  it("uninstall when installed, no flags", () => {
    expect(plan(local, {}, { isInteractive: false, packageInstalled: true }))
      .toEqual({ kind: "uninstall" });
  });
  it("uninstall when installed, --purge-global is a no-op for local", () => {
    expect(plan(local, { purgeGlobal: true }, { isInteractive: false, packageInstalled: true }))
      .toEqual({ kind: "uninstall" });
  });
});

describe("planRemoveAction — global context obeys the documented matrix", () => {
  it("--purge-global → uninstall (no prompt) even when non-interactive", () => {
    expect(plan(global_, { purgeGlobal: true }, { isInteractive: false, packageInstalled: true }))
      .toEqual({ kind: "uninstall" });
  });
  it("interactive without --purge-global → prompt (not warning)", () => {
    expect(plan(global_, {}, { isInteractive: true, packageInstalled: true }))
      .toEqual({ kind: "prompt-global", warningOnly: false });
  });
  it("non-interactive without --purge-global → warningOnly (no prompt, no uninstall)", () => {
    expect(plan(global_, {}, { isInteractive: false, packageInstalled: true }))
      .toEqual({ kind: "prompt-global", warningOnly: true });
  });
});
