import { readFileSync, readdirSync } from 'node:fs';
import { z } from 'zod';

const ScenarioSchema = z.object({
  name: z.string(),
  agent: z.string(),
  option: z.string().optional(),
  // Everything Claude may say, claim or approve; Claude stops rather than go beyond it
  brief: z.string(),
  // Look up a real, current local story before the run and add its sourced facts to the brief
  research: z.object({ localStoryIn: z.string().optional() }).optional(),
  input: z.string().optional(),
  reply: z.string().optional(),
  // The only buttons Claude may press; anything else ends the run before a click
  allowedButtons: z.array(z.string()).default(['Approve', 'Complete Task']),
  expect: z.object({
    artifactFormat: z.string().optional(),
    successCriteria: z.string(),
  }),
});

export type Scenario = z.infer<typeof ScenarioSchema> & { id: string };

export function loadScenario(id: string): Scenario {
  return { ...ScenarioSchema.parse(JSON.parse(readFileSync(`scenarios/${id}.json`, 'utf8'))), id };
}

export function loadScenarios() {
  return readdirSync('scenarios')
    .filter((file) => file.endsWith('.json'))
    .map((file) => loadScenario(file.replace(/\.json$/, '')));
}
