// covers: function:compileStageGraph, cli:aidlc-runner-gen(write,scopes)

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetGraphCache,
  compileStageGraph,
} from "../../core/tools/aidlc-graph.ts";
import {
  _resetScopeMappingForTests,
  _resetStageGraphForTests,
} from "../../core/tools/aidlc-lib.ts";
import {
  REPO_ROOT,
  setupIntegrationProject,
} from "../harness/fixtures.ts";

const BUN = process.execPath;
const CORE_RUNNER_GEN = join(REPO_ROOT, "core", "tools", "aidlc-runner-gen.ts");
const CORE_SCOPES = join(REPO_ROOT, "core", "scopes");

const tempDirs: string[] = [];
afterAll(() => {
  for (const d of tempDirs) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

function resetGraphCaches(): void {
  __resetGraphCache();
  _resetStageGraphForTests();
  _resetScopeMappingForTests();
}

function withEnv<T>(env: Record<string, string>, fn: () => T): T {
  const prior = new Map<string, string | undefined>();
  for (const key of Object.keys(env)) prior.set(key, process.env[key]);
  Object.assign(process.env, env);
  resetGraphCaches();
  try {
    return fn();
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetGraphCaches();
  }
}

function stageFrontmatter(slug: string, extra = ""): string {
  return [
    "---",
    `slug: ${slug}`,
    extra.trim(),
    "phase: construction",
    "execution: ALWAYS",
    "condition: always",
    "lead_agent: aidlc-quality-agent",
    "support_agents: []",
    "mode: inline",
    "produces: []",
    "consumes: []",
    "requires_stage: []",
    "inputs: test input",
    "outputs: test output",
    "---",
    "",
    `# ${slug}`,
    "",
  ].filter((line) => line !== "").join("\n");
}

function compileFixture(stages: Record<string, string>) {
  const root = tempDir("aidlc-t221-compile-");
  const stagesDir = join(root, "stages");
  const construction = join(stagesDir, "construction");
  mkdirSync(construction, { recursive: true });
  for (const [slug, body] of Object.entries(stages)) {
    writeFileSync(join(construction, `${slug}.md`), body, "utf-8");
  }
  const graphPath = join(root, "stage-graph.json");
  const gridPath = join(root, "scope-grid.json");
  const rulesDir = join(root, "rules");
  const sensorsDir = join(root, "sensors");
  mkdirSync(rulesDir, { recursive: true });
  mkdirSync(sensorsDir, { recursive: true });
  writeFileSync(graphPath, "[]\n", "utf-8");
  writeFileSync(gridPath, "{}\n", "utf-8");

  return withEnv(
    {
      AIDLC_STAGES_DIR: stagesDir,
      AIDLC_STAGE_GRAPH: graphPath,
      AIDLC_SCOPE_GRID: gridPath,
      AIDLC_RULES_DIR: rulesDir,
      AIDLC_SENSORS_DIR: sensorsDir,
      AIDLC_HARNESS_DIR: ".claude",
    },
    () => compileStageGraph(),
  );
}

function runRunnerGen(gen: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(BUN, [gen, ...args], {
    encoding: "utf-8",
    env: { ...process.env, AIDLC_HARNESS_DIR: ".claude", ...env },
  });
}

describe("t221 plugin ownership and runner naming", () => {
  test("compile carries plugin only for plugin-owned stages", () => {
    const compiled = compileFixture({
      "code-generation": stageFrontmatter("code-generation"),
      "test-pro-integration": stageFrontmatter(
        "test-pro-integration",
        "plugin: test-pro",
      ),
    });
    const core = compiled.stages.find((s) => s.slug === "code-generation");
    const plugin = compiled.stages.find((s) => s.slug === "test-pro-integration");
    expect(plugin?.plugin).toBe("test-pro");
    expect(Object.prototype.hasOwnProperty.call(core ?? {}, "plugin")).toBe(false);
    expect(compiled.json).toContain('"plugin": "test-pro"');
  });

  test("compile rejects plugin stages whose slug does not start with the plugin prefix", () => {
    expect(() =>
      compileFixture({
        "plain-integration": stageFrontmatter(
          "plain-integration",
          "plugin: test-pro",
        ),
      }),
    ).toThrow(/plain-integration.*plugin "test-pro".*must start with "test-pro-"/);
  });

  test("compile rejects plugin: aidlc; core stages omit plugin instead", () => {
    expect(() =>
      compileFixture({
        "aidlc-custom": stageFrontmatter("aidlc-custom", "plugin: aidlc"),
      }),
    ).toThrow(/plugin "aidlc"; omit plugin for core stages/);
  });

  test("stage runner names are core-prefixed for core stages and bare for plugin stages", () => {
    const project = setupIntegrationProject({ noAidlcDocs: true });
    tempDirs.push(project);
    const graphPath = join(project, ".claude", "tools", "data", "stage-graph.json");
    const graph = JSON.parse(readFileSync(graphPath, "utf-8"));
    graph.push({
      slug: "test-pro-integration",
      number: "3.85",
      name: "Cross-Unit Integration Testing",
      plugin: "test-pro",
      phase: "construction",
      execution: "ALWAYS",
      lead_agent: "aidlc-quality-agent",
      support_agents: [],
      mode: "inline",
      produces: [],
      consumes: [],
      requires_stage: [],
      inputs: "test input",
      outputs: "test output",
      rules_in_context: [],
      sensors_applicable: [],
    });
    writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`, "utf-8");

    const gen = join(project, ".claude", "tools", "aidlc-runner-gen.ts");
    cpSync(CORE_RUNNER_GEN, gen);
    const r = runRunnerGen(gen, ["write"]);
    expect(r.status).toBe(0);

    expect(existsSync(join(project, ".claude", "skills", "aidlc-code-generation", "SKILL.md"))).toBe(true);
    const pluginSkill = join(project, ".claude", "skills", "test-pro-integration", "SKILL.md");
    expect(existsSync(pluginSkill)).toBe(true);
    expect(existsSync(join(project, ".claude", "skills", "aidlc-test-pro-integration", "SKILL.md"))).toBe(false);
    const body = readFileSync(pluginSkill, "utf-8");
    expect(body).toContain("name: test-pro-integration");
    expect(body).toContain("from the test-pro plugin");
  });

  test("scope runner default batch is selected by runner: true; --all includes unflagged scopes", () => {
    const scopesDir = tempDir("aidlc-t221-scopes-");
    for (const file of readdirSync(CORE_SCOPES).filter((f) => f.endsWith(".md"))) {
      cpSync(join(CORE_SCOPES, file), join(scopesDir, file));
    }
    writeFileSync(
      join(scopesDir, "aidlc-fixture-scope.md"),
      [
        "---",
        "name: fixture-scope",
        "depth: Minimal",
        "keywords: []",
        "description: Fixture scope with no runner flag",
        "---",
        "",
        "# fixture-scope",
        "",
      ].join("\n"),
      "utf-8",
    );

    const defaultOut = tempDir("aidlc-t221-scope-out-");
    const defaultRun = runRunnerGen(
      CORE_RUNNER_GEN,
      ["scopes", "--out", defaultOut],
      { AIDLC_SCOPES_DIR: scopesDir },
    );
    expect(defaultRun.status).toBe(0);

    const defaultRunners = readdirSync(defaultOut).sort();
    expect(defaultRunners).toEqual([
      "aidlc-bugfix",
      "aidlc-feature",
      "aidlc-mvp",
      "aidlc-security-patch",
    ]);
    expect(existsSync(join(defaultOut, "aidlc-fixture-scope", "SKILL.md"))).toBe(false);

    const allOut = tempDir("aidlc-t221-scope-all-");
    const allRun = runRunnerGen(
      CORE_RUNNER_GEN,
      ["scopes", "--all", "--out", allOut],
      { AIDLC_SCOPES_DIR: scopesDir },
    );
    expect(allRun.status).toBe(0);
    expect(existsSync(join(allOut, "aidlc-fixture-scope", "SKILL.md"))).toBe(true);
  });
});
