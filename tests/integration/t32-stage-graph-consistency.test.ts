// covers: subcommand:aidlc-utility:stage-table, data:stage-graph
//
// t32 — Stage Graph generated table consistency.
//
// The Stage Graph table in SKILL.md is a generated mirror of the compiled
// tools/data/stage-graph.json. The engine routes from the compiled graph, not
// from prose, so this test guards the generated region rather than re-validating
// a hand-maintained table against stage source files.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AIDLC_SRC } from "../harness/fixtures.ts";

const BUN = process.execPath;
const TOOL = join(AIDLC_SRC, "tools", "aidlc-utility.ts");
const GRAPH = join(AIDLC_SRC, "tools", "data", "stage-graph.json");

interface GraphStage {
  slug: string;
  name: string;
}

interface TableRow {
  slug: string;
  stage: string;
}

function runStageTable(args: string[] = []): { status: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, AIDLC_STAGE_GRAPH: GRAPH };
  delete env.AIDLC_SKILL_MD_PATH;
  const r = spawnSync(BUN, [TOOL, "stage-table", ...args], {
    cwd: join(AIDLC_SRC, ".."),
    encoding: "utf-8",
    env,
  });
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function extractRows(tableRegion: string): TableRow[] {
  return tableRegion
    .split(/\r?\n/)
    .filter((line) => line.startsWith("|"))
    .slice(2)
    .map((line) => line.split("|").map((cell) => cell.trim()))
    .filter((cells) => cells[1])
    .map((cells) => ({
      slug: cells[1],
      stage: cells[3],
    }));
}

function counts(values: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const value of values) out.set(value, (out.get(value) ?? 0) + 1);
  return out;
}

describe("t32 Stage Graph generated table consistency", () => {
  test("stage-table --check passes on the shipped SKILL.md region", () => {
    const r = runStageTable(["--check"]);
    expect(r.status, r.stderr).toBe(0);
  });

  test("rendered table names every compiled stage exactly once", () => {
    const r = runStageTable();
    expect(r.status, r.stderr).toBe(0);

    const graph = JSON.parse(readFileSync(GRAPH, "utf-8")) as GraphStage[];
    const rows = extractRows(r.stdout);
    expect(rows.length).toBe(graph.length);

    const rowSlugCounts = counts(rows.map((row) => row.slug));
    const rowNameCounts = counts(rows.map((row) => row.stage));
    for (const stage of graph) {
      expect(rowSlugCounts.get(stage.slug) ?? 0).toBe(1);
      expect(rowNameCounts.get(stage.name) ?? 0).toBe(1);
    }

    const graphSlugs = new Set(graph.map((stage) => stage.slug));
    const graphNames = new Set(graph.map((stage) => stage.name));
    expect(rows.filter((row) => !graphSlugs.has(row.slug))).toEqual([]);
    expect(rows.filter((row) => !graphNames.has(row.stage))).toEqual([]);
  });
});
