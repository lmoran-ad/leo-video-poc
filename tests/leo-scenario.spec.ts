import { expect, test } from '@playwright/test';
import { OUTPUT_DIR } from '../playwright.config';
import {
  answerWithClaude,
  briefWithStory,
  expectRealSources,
  findLocalStory,
  judgeRun,
  pickStoryArea,
  writeLeoPrompt,
} from './leoClaude';
import { GENERATION_TIMEOUT } from './leoScenario';
import { runScenarioThroughUi } from './leoUi';
import { loadScenarios } from './scenario';

test.use({ actionTimeout: 30_000, contextOptions: { recordHar: { path: `${OUTPUT_DIR}/leo-network.har` } } });

for (const scenario of loadScenarios()) {
  test(`scenario ${scenario.id}: ${scenario.name}`, async ({ page, request }, testInfo) => {
    // One scenario per run, named explicitly, so a single command can never pay for several renders
    test.skip(
      process.env.LEO_AI_RUN !== '1' || process.env.LEO_SCENARIO !== scenario.id,
      `Paid run: set LEO_AI_RUN=1 and LEO_SCENARIO=${scenario.id}`,
    );
    test.setTimeout(GENERATION_TIMEOUT + 20 * 60_000);

    let brief = scenario.brief;
    if (scenario.research) {
      const area = pickStoryArea(scenario.research.localStoryIn);
      testInfo.annotations.push({ type: 'area', description: area });
      const story = await findLocalStory(area);
      await testInfo.attach('local-story.json', { body: JSON.stringify(story, null, 2), contentType: 'application/json' });
      await expectRealSources(request, story);
      brief = briefWithStory(brief, story);
    }
    testInfo.annotations.push({ type: 'brief', description: brief });

    const run = await runScenarioThroughUi({ page, request, testInfo }, scenario, {
      input: async (prefill) => scenario.input ?? (await writeLeoPrompt(brief, prefill)).message,
      answer: answerWithClaude(brief),
    });

    const verdict = await judgeRun(brief, scenario.expect.successCriteria, run);
    testInfo.annotations.push({ type: 'verdict', description: JSON.stringify(verdict) });
    expect(verdict.pass, `Claude's review: ${verdict.reason}`).toBe(true);
  });
}
