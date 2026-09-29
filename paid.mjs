import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const SCENARIO = process.env.LEO_SCENARIO ?? 'local-story-reel';

// npm runs scripts through cmd.exe on Windows, where `FLAG=1 npx ...` doesn't work, so paid runs go through here
const RUNS = {
  ui: {
    flag: 'LEO_VIDEO_RUN',
    args: ['--project=setup', '--project=leo', '-g', 'log in to Bolt|creates a local story reel'],
  },
  api: { flag: 'LEO_VIDEO_API_RUN', args: ['--project=api', '-g', 'renders a local story reel'] },
  ai: {
    flag: 'LEO_AI_RUN',
    env: { LEO_SCENARIO: SCENARIO },
    args: ['--project=setup', '--project=leo', '-g', `log in to Bolt|scenario ${SCENARIO}:`],
  },
};

const [name, ...rest] = process.argv.slice(2);
const run = RUNS[name];
if (!run) {
  console.error(`Usage: node paid.mjs <${Object.keys(RUNS).join('|')}> [--yes]`);
  process.exit(1);
}

if (!rest.includes('--yes')) {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question(`This creates a real, paid Leo video (${name}). Continue? (y/N) `);
  prompt.close();
  if (answer.trim().toLowerCase() !== 'y') process.exit(0);
}

const env = { ...process.env, ...run.env, [run.flag]: '1' };
const extra = rest.filter((arg) => arg !== '--yes');
// No shell: on Windows it would turn the "|" in the -g filters into a pipe
const cli = fileURLToPath(new URL('./node_modules/@playwright/test/cli.js', import.meta.url));
const { status } = spawnSync(process.execPath, [cli, 'test', ...run.args, ...extra], { env, stdio: 'inherit' });
process.exit(status ?? 1);
