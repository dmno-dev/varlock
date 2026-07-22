import type { BenchContext, ScenarioResult } from '../types.ts';
import { runCliLoadScenarios } from './cli-load.ts';
import { runCliRunScenarios } from './cli-run.ts';
import { runCliScanAuditScenarios } from './cli-scan-audit.ts';
import { runNextScenarios } from './integration-next.ts';
import { runViteScenarios } from './integration-vite.ts';
import { runPythonScenarios } from './lang-python.ts';
import { runGoScenarios } from './lang-go.ts';
import { printScenarioLine } from '../report.ts';

export type ScenarioGroup = {
  name: string;
  run: (ctx: BenchContext) => Promise<Array<ScenarioResult>>;
};

export const SCENARIO_GROUPS: Array<ScenarioGroup> = [
  { name: 'cli-load', run: runCliLoadScenarios },
  { name: 'cli-run', run: runCliRunScenarios },
  { name: 'cli-scan-audit', run: runCliScanAuditScenarios },
  { name: 'integration-next', run: runNextScenarios },
  { name: 'integration-vite', run: runViteScenarios },
  { name: 'lang-python', run: runPythonScenarios },
  { name: 'lang-go', run: runGoScenarios },
];

export async function runAllScenarios(
  ctx: BenchContext,
  only?: Array<string>,
): Promise<Array<ScenarioResult>> {
  const groups = only?.length
    ? SCENARIO_GROUPS.filter((g) => only.includes(g.name))
    : SCENARIO_GROUPS;

  const all: Array<ScenarioResult> = [];
  for (const group of groups) {
    console.log(`\n== ${group.name} ==`);
    const results = await group.run(ctx);
    for (const r of results) {
      printScenarioLine(r);
      all.push(r);
    }
  }
  return all;
}
