// t224-scope-name-decoupling: keep scope behavior data-driven.
//
// covers: core/tools/aidlc-lib.ts loadScopeMetadata/selectionAwareDefaultScope,
// core/tools/aidlc-orchestrate.ts env-scope fallback and skeleton stance source

import { afterEach, describe, expect, test } from "bun:test";
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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  _resetHarnessDataForTests,
  _resetScopeMappingForTests,
  _resetStageGraphForTests,
  loadScopeMetadata,
} from "../../core/tools/aidlc-lib.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CORE_TOOLS = join(REPO_ROOT, "core", "tools");
const CORE_SCOPES = join(REPO_ROOT, "core", "scopes");
const DIST_CLAUDE = join(REPO_ROOT, "dist", "claude", ".claude");
const TEST_PRO_SCOPE = join(REPO_ROOT, "plugins", "test-pro", "scopes", "test-pro-validation.md");
const BUN = process.execPath;

const CORE_SCOPE_NAMES = [
  "enterprise",
  "mvp",
  "feature",
  "poc",
  "workshop",
  "infra",
  "bugfix",
  "security-patch",
  "refactor",
] as const;

const SKELETON_ON_CORE_SCOPES = [
  "enterprise",
  "feature",
  "infra",
  "mvp",
  "poc",
  "workshop",
];

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.AIDLC_SCOPES_DIR;
  _resetScopeMappingForTests();
  _resetStageGraphForTests();
  _resetHarnessDataForTests();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function resetCaches(): void {
  _resetScopeMappingForTests();
  _resetStageGraphForTests();
  _resetHarnessDataForTests();
}

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const prior = new Map<string, string | undefined>();
  for (const key of Object.keys(env)) prior.set(key, process.env[key]);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetCaches();
  try {
    return fn();
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetCaches();
  }
}

function writeScope(dir: string, name: string, skeleton?: string): void {
  const skeletonLine = skeleton === undefined ? [] : [`skeleton: ${skeleton}`];
  writeFileSync(
    join(dir, `${name}.md`),
    [
      "---",
      `name: ${name}`,
      "depth: Minimal",
      "keywords: []",
      "description: Fixture scope",
      ...skeletonLine,
      "---",
      "",
      `# ${name}`,
      "",
    ].join("\n"),
    "utf-8",
  );
}

function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let state: "code" | "line" | "block" | "string" | "template" = "code";
  let quote = "";
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1] ?? "";

    if (state === "line") {
      if (ch === "\n") {
        out += "\n";
        state = "code";
      }
      i++;
      continue;
    }
    if (state === "block") {
      if (ch === "*" && next === "/") {
        i += 2;
        state = "code";
      } else {
        if (ch === "\n") out += "\n";
        i++;
      }
      continue;
    }
    if (state === "string" || state === "template") {
      out += ch;
      if (ch === "\\") {
        out += next;
        i += 2;
        continue;
      }
      if (ch === quote) state = "code";
      i++;
      continue;
    }

    if (ch === "/" && next === "/") {
      state = "line";
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      state = "block";
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      state = "string";
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "`") {
      state = "template";
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function arrayLiteralBodies(code: string): string[] {
  const bodies: string[] = [];
  const re = /\[((?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[^\[\]])*)\]/gs;
  let match: RegExpExecArray | null;
  while ((match = re.exec(code)) !== null) bodies.push(match[1]);
  return bodies;
}

function literalScopeNames(body: string): string[] {
  const names = new Set<string>();
  const re = /(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    const value = match[2];
    if ((CORE_SCOPE_NAMES as readonly string[]).includes(value)) names.add(value);
  }
  return [...names].sort();
}

function makePluginOnlyInstall(): string {
  const project = tempDir("aidlc-t224-plugin-only-");
  const harness = join(project, ".claude");
  cpSync(DIST_CLAUDE, harness, { recursive: true });
  cpSync(TEST_PRO_SCOPE, join(harness, "scopes", "test-pro-validation.md"));

  const harnessJson = join(harness, "tools", "data", "harness.json");
  const harnessData = JSON.parse(readFileSync(harnessJson, "utf-8")) as Record<string, unknown>;
  harnessData.plugins = ["test-pro"];
  writeFileSync(harnessJson, `${JSON.stringify(harnessData, null, 2)}\n`, "utf-8");

  const grid = {
    "test-pro-validation": {
      stages: {
        "requirements-analysis": "EXECUTE",
      },
    },
  };
  writeFileSync(
    join(harness, "tools", "data", "scope-grid.json"),
    `${JSON.stringify(grid, null, 2)}\n`,
    "utf-8",
  );
  mkdirSync(join(project, "aidlc"), { recursive: true });
  return project;
}

describe("t224 static scope-name coupling probe", () => {
  test("core tools do not carry 3+ core scope names in one Set/array literal", () => {
    const failures: string[] = [];
    for (const file of readdirSync(CORE_TOOLS).filter((name) => name.endsWith(".ts")).sort()) {
      const path = join(CORE_TOOLS, file);
      const stripped = stripComments(readFileSync(path, "utf-8"));
      for (const body of arrayLiteralBodies(stripped)) {
        const names = literalScopeNames(body);
        if (names.length >= 3) failures.push(`${file}: [${names.join(", ")}]`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe("t224 skeleton scope metadata", () => {
  test("fixture scopes parse skeleton on/off, absent defaults off, and invalid names the file", () => {
    const dir = tempDir("aidlc-t224-scopes-");
    writeScope(dir, "skeleton-on", "on");
    writeScope(dir, "skeleton-off", "off");
    writeScope(dir, "skeleton-absent");

    withEnv({ AIDLC_SCOPES_DIR: dir }, () => {
      const metadata = loadScopeMetadata();
      expect(metadata["skeleton-on"].skeleton).toBe(true);
      expect(metadata["skeleton-off"].skeleton).toBe(false);
      expect(metadata["skeleton-absent"].skeleton).toBe(false);
    });

    const invalidDir = tempDir("aidlc-t224-invalid-scopes-");
    writeScope(invalidDir, "bad-skeleton", "maybe");
    expect(() =>
      withEnv({ AIDLC_SCOPES_DIR: invalidDir }, () => loadScopeMetadata()),
    ).toThrow(new RegExp(`${join(invalidDir, "bad-skeleton.md").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*maybe`));
  });

  test("core skeleton defaults match the previous six-scope behavior", () => {
    withEnv({ AIDLC_SCOPES_DIR: CORE_SCOPES }, () => {
      const metadata = loadScopeMetadata();
      const skeletonOn = Object.values(metadata)
        .filter((scope) => scope.skeleton)
        .map((scope) => scope.name)
        .sort();
      expect(skeletonOn).toEqual(SKELETON_ON_CORE_SCOPES);
    });
  });
});

describe("t224 env-scope fallback under plugin-only selection", () => {
  test("AWS_AIDLC_DEFAULT_SCOPE naming disabled core falls back to the sole plugin scope", () => {
    const project = makePluginOnlyInstall();
    const tool = join(project, ".claude", "tools", "aidlc-orchestrate.ts");
    const result = spawnSync(
      BUN,
      [
        tool,
        "next",
        "--stage",
        "requirements-analysis",
        "--single",
        "--project-dir",
        project,
      ],
      {
        cwd: project,
        encoding: "utf-8",
        env: {
          ...process.env,
          AIDLC_HARNESS_DIR: ".claude",
          AWS_AIDLC_DEFAULT_SCOPE: "feature",
        },
      },
    );
    const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect(result.status).toBe(0);
    expect(out).not.toContain("Invalid AWS_AIDLC_DEFAULT_SCOPE");
    expect(out).toContain('"kind":"run-stage"');
    expect(out).toContain('"stage":"requirements-analysis"');
  });
});
