// t223-plugin-selection: install-time plugin selection.
//
// covers: core/tools/aidlc-lib.ts pluginsEnabled/loadStageGraphAll,
// core/tools/aidlc-graph.ts enabled flags + closure guard,
// core/tools/aidlc-utility.ts select-plugins, core/tools/aidlc-runner-gen.ts
// pruning, and the generated SKILL.md table regions.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PACKAGE_TS = join(REPO_ROOT, "scripts", "package.ts");
const BUN = process.execPath;
const TIMEOUT_MS = 60_000;
const PLUGIN = "test-pro";
const CLAUDE_DIST_ROOT = join(REPO_ROOT, "dist", "claude");
const CLAUDE_DIST = join(REPO_ROOT, "dist", "claude", ".claude");
const STAGE_TABLE_BEGIN =
  "<!-- BEGIN: compiled stage graph via `bun aidlc-utility.ts stage-table` - do NOT hand-edit -->";
const STAGE_TABLE_END = "<!-- END: compiled stage graph -->";

function graphPath(project: string): string {
  return join(project, ".claude", "tools", "data", "stage-graph.json");
}

function gridPath(project: string): string {
  return join(project, ".claude", "tools", "data", "scope-grid.json");
}

function harnessPath(project: string): string {
  return join(project, ".claude", "tools", "data", "harness.json");
}

function graph(project: string): Array<Record<string, any>> {
  return JSON.parse(readFileSync(graphPath(project), "utf-8"));
}

function grid(project: string): Record<string, { stages: Record<string, string> }> {
  return JSON.parse(readFileSync(gridPath(project), "utf-8"));
}

function runUtility(project: string, args: string[]) {
  return spawnSync(BUN, [join(project, ".claude", "tools", "aidlc-utility.ts"), ...args], {
    cwd: project,
    encoding: "utf-8",
    timeout: TIMEOUT_MS - 5_000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: project, AIDLC_HARNESS_DIR: ".claude" },
  });
}

function runOrchestrate(project: string, args: string[]) {
  return spawnSync(BUN, [".claude/tools/aidlc-orchestrate.ts", ...args], {
    cwd: project,
    encoding: "utf-8",
    timeout: TIMEOUT_MS - 5_000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: project, AIDLC_HARNESS_DIR: ".claude" },
  });
}

function stageTableRegion(project: string): string {
  const skill = readFileSync(join(project, ".claude", "skills", "aidlc", "SKILL.md"), "utf-8");
  const begin = skill.indexOf(STAGE_TABLE_BEGIN);
  const end = skill.indexOf(STAGE_TABLE_END, begin);
  expect(begin).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(begin);
  return skill.slice(begin, end + STAGE_TABLE_END.length);
}

function composeTestPro(project: string, pluginBuilt: string): void {
  const compose = spawnSync(BUN, [join(pluginBuilt, "hooks", "compose.ts")], {
    cwd: project,
    encoding: "utf-8",
    timeout: TIMEOUT_MS - 5_000,
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: pluginBuilt,
      CLAUDE_PROJECT_DIR: project,
      AIDLC_HARNESS_DIR: ".claude",
    },
  });
  if (compose.status !== 0) throw new Error(`compose.ts failed: ${compose.stderr}`);
}

function copyClaudeInstall(project: string): void {
  cpSync(CLAUDE_DIST, join(project, ".claude"), { recursive: true });
  cpSync(join(CLAUDE_DIST_ROOT, "aidlc"), join(project, "aidlc"), { recursive: true });
}

function writeSortedGrid(project: string, scopeGrid: Record<string, { stages: Record<string, string> }>): void {
  const sorted: Record<string, { stages: Record<string, string> }> = {};
  for (const key of Object.keys(scopeGrid).sort()) sorted[key] = scopeGrid[key];
  writeFileSync(gridPath(project), `${JSON.stringify(sorted, null, 2)}\n`, "utf-8");
}

describe("t223 plugin selection — install chooses visible plugin surfaces", () => {
  let tmp: string;
  let pluginBuilt: string;
  let project: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "aidlc-t223-"));
    pluginBuilt = join(tmp, "plugin", "claude");
    const build = spawnSync(BUN, [PACKAGE_TS, "plugin", "build", PLUGIN, "claude", pluginBuilt], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      timeout: TIMEOUT_MS - 5_000,
    });
    if (build.status !== 0) throw new Error(`plugin build failed: ${build.stderr}`);

    project = join(tmp, "proj");
    copyClaudeInstall(project);
    composeTestPro(project, pluginBuilt);
  });

  afterAll(() => {
    if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  test("selecting test-pro disables core surfaces but keeps bootstrap and full graph", () => {
    const fullGraphBefore = readFileSync(graphPath(project), "utf-8");

    const selected = runUtility(project, ["select-plugins", "test-pro"]);
    expect(selected.status).toBe(0);

    const harness = JSON.parse(readFileSync(harnessPath(project), "utf-8"));
    expect(harness.plugins).toEqual(["test-pro"]);

    const nodes = graph(project);
    expect(nodes.find((s) => s.slug === "code-generation")?.enabled).toBe(false);
    expect(nodes.find((s) => s.slug === "test-pro-integration")?.enabled).toBeUndefined();
    expect(nodes.find((s) => s.slug === "workspace-scaffold")?.enabled).toBeUndefined();

    const runners = join(project, ".claude", "skills");
    expect(existsSync(join(runners, "test-pro-integration", "SKILL.md"))).toBe(true);
    expect(existsSync(join(runners, "test-pro-validation", "SKILL.md"))).toBe(true);
    expect(existsSync(join(runners, "aidlc-code-generation", "SKILL.md"))).toBe(false);
    expect(existsSync(join(runners, "aidlc-feature", "SKILL.md"))).toBe(false);

    const scopeGrid = grid(project);
    expect(Object.keys(scopeGrid)).toEqual(["test-pro-validation"]);
    expect(scopeGrid["test-pro-validation"].stages["workspace-scaffold"]).toBe("EXECUTE");
    expect(scopeGrid["test-pro-validation"].stages["test-pro-integration"]).toBe("EXECUTE");
    expect(scopeGrid["test-pro-validation"].stages["code-generation"]).toBeUndefined();

    const table = stageTableRegion(project);
    expect(table).toContain("| workspace-scaffold |");
    expect(table).toContain("| test-pro-integration |");
    expect(table).not.toContain("| code-generation |");

    const doctor = runUtility(project, ["doctor"]);
    expect(doctor.status).toBe(0);
    expect(doctor.stdout).toContain("Enabled plugins: test-pro");

    const both = runUtility(project, ["select-plugins", "aidlc,test-pro"]);
    expect(both.status).toBe(0);
    expect(readFileSync(graphPath(project), "utf-8")).toBe(fullGraphBefore);
  });

  test("selecting aidlc prunes test-pro runners while plugin files remain installed", () => {
    const selected = runUtility(project, ["select-plugins", "aidlc"]);
    expect(selected.status).toBe(0);

    expect(existsSync(join(project, ".claude", "skills", "test-pro-integration", "SKILL.md"))).toBe(false);
    expect(existsSync(join(project, ".claude", "skills", "test-pro-validation", "SKILL.md"))).toBe(false);
    expect(existsSync(join(project, ".claude", "aidlc-common", "stages", "construction", "test-pro-integration.md"))).toBe(true);
    expect(graph(project).find((s) => s.slug === "test-pro-integration")?.enabled).toBe(false);
  });

  test("unknown plugin names hard-fail and list valid names", () => {
    const result = runUtility(project, ["select-plugins", "aidlc,nope"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unknown plugin name");
    expect(result.stderr).toContain("aidlc");
    expect(result.stderr).toContain("test-pro");
  });

  test("late-step failure rolls back harness, graph, and grid then regenerates restored selection", () => {
    const beforeHarness = readFileSync(harnessPath(project), "utf-8");
    const beforeGraph = readFileSync(graphPath(project), "utf-8");
    const beforeGrid = readFileSync(gridPath(project), "utf-8");

    const blocker = join(project, ".claude", "skills", "test-pro-integration");
    writeFileSync(blocker, "not a directory\n", "utf-8");

    const result = runUtility(project, ["select-plugins", "aidlc,test-pro"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Restored harness.json, stage-graph.json, and scope-grid.json");
    expect(readFileSync(harnessPath(project), "utf-8")).toBe(beforeHarness);
    expect(readFileSync(graphPath(project), "utf-8")).toBe(beforeGraph);
    expect(readFileSync(gridPath(project), "utf-8")).toBe(beforeGrid);
  });

  test("closure guard names the disabled producer plugin, producer, artifact, and consumer", () => {
    const closureProj = join(tmp, "closure");
    copyClaudeInstall(closureProj);
    const stageDir = join(closureProj, ".claude", "aidlc-common", "stages", "construction");
    const scopeDir = join(closureProj, ".claude", "scopes");
    mkdirSync(stageDir, { recursive: true });
    mkdirSync(scopeDir, { recursive: true });
    writeFileSync(
      join(stageDir, "guard-core-consumer.md"),
      [
        "---",
        "slug: guard-core-consumer",
        "plugin: guard",
        "phase: construction",
        "execution: ALWAYS",
        "condition: always",
        "lead_agent: aidlc-developer-agent",
        "support_agents: []",
        "mode: inline",
        "produces:",
        "  - guard-output",
        "consumes:",
        "  - artifact: intent-statement",
        "    required: true",
        "requires_stage: []",
        "scopes:",
        "  - guard-validation",
        "inputs: x",
        "outputs: y",
        "---",
        "",
        "# Guard core consumer",
        "",
      ].join("\n"),
      "utf-8",
    );
    writeFileSync(
      join(scopeDir, "guard-validation.md"),
      [
        "---",
        "name: guard-validation",
        "plugin: guard",
        "depth: Minimal",
        "keywords: []",
        "description: Guard validation",
        "runner: true",
        "---",
        "",
        "# guard-validation",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = runUtility(closureProj, ["select-plugins", "guard"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Plugin selection closure failed");
    expect(result.stderr).toContain("guard-core-consumer");
    expect(result.stderr).toContain("intent-statement");
    expect(result.stderr).toContain("intent-capture");
    expect(result.stderr).toContain("aidlc");
  });

  test("composed scopes survive plugin selection with intact grid and runner", () => {
    const composedProj = join(tmp, "composed");
    copyClaudeInstall(composedProj);
    composeTestPro(composedProj, pluginBuilt);

    const scopeName = "custom-composed";
    const scopeDir = join(composedProj, ".claude", "scopes");
    mkdirSync(scopeDir, { recursive: true });
    writeFileSync(
      join(scopeDir, "aidlc-custom-composed.md"),
      [
        "---",
        `name: ${scopeName}`,
        "depth: Composed",
        "keywords: []",
        "runner: true",
        "---",
        "",
        "# custom-composed",
        "",
      ].join("\n"),
      "utf-8",
    );

    const seededGrid = grid(composedProj);
    const seededStages = { ...seededGrid.feature.stages };
    const seededEntry = { stages: seededStages };
    const seededEntryJson = JSON.stringify(seededEntry);
    seededGrid[scopeName] = seededEntry;
    writeSortedGrid(composedProj, seededGrid);

    const firstExecute = Object.entries(seededStages).find(
      ([slug, value]) =>
        value === "EXECUTE" &&
        !["workspace-scaffold", "workspace-detection", "state-init"].includes(slug),
    )?.[0];
    expect(firstExecute).toBe("intent-capture");

    const selectedPluginOnly = runUtility(composedProj, ["select-plugins", "test-pro"]);
    expect(selectedPluginOnly.status).toBe(0);
    expect(grid(composedProj)[scopeName].stages).toEqual(seededStages);
    expect(JSON.stringify(grid(composedProj)[scopeName])).toBe(seededEntryJson);
    expect(existsSync(join(composedProj, ".claude", "skills", "aidlc-custom-composed", "SKILL.md"))).toBe(true);

    const selectedBoth = runUtility(composedProj, ["select-plugins", "aidlc,test-pro"]);
    expect(selectedBoth.status).toBe(0);
    expect(JSON.stringify(grid(composedProj)[scopeName])).toBe(seededEntryJson);

    const init = runUtility(composedProj, ["init", "--scope", scopeName, "--project-dir", composedProj]);
    expect(init.status).toBe(0);

    const next = runOrchestrate(composedProj, ["next", "--scope", scopeName]);
    expect(next.status).toBe(0);
    expect(next.stdout).not.toContain("Unknown scope");
    const directive = JSON.parse(next.stdout.trim());
    expect(directive.kind).toBe("run-stage");
    expect(directive.stage).toBe(firstExecute);
  });
});
