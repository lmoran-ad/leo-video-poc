import { expect, test } from '@playwright/test';
import { OUTPUT_DIR } from '../playwright.config';
import { CHEYENNE, GENERATION_TIMEOUT, INPUT, LOCAL_STORY_PREFILL, REPLY } from './leoScenario';
import { fillMessage, openAgent, runScenarioThroughUi, type Answerer } from './leoUi';

const VIDEO_OPTIONS = [
  'Market update reel',
  'Reel about a local story',
  'Where rates are right now',
  'Reel about my new listing',
];

// Fixed answers: click whichever approval card is showing, otherwise send the scripted reply
const scriptedAnswer: Answerer = async ({ buttons }) =>
  buttons.length ? { action: 'click', button: buttons[0] } : { action: 'reply', text: REPLY };

test('Avatar Video Creator is ready to send a local story reel', async ({ page }) => {
  // Leo bills on writes, so this pre-Send test must never reach one
  const blockedWrites: string[] = [];
  await page.route('https://ari.therealbrokerage.com/**', (route) => {
    if (route.request().method() === 'GET') return route.continue();
    blockedWrites.push(`${route.request().method()} ${route.request().url()}`);
    return route.abort();
  });

  const prefill = await openAgent(page, CHEYENNE, async () => {
    for (const option of VIDEO_OPTIONS) {
      await expect(page.getByRole('button', { name: new RegExp(`^${option}`) })).toBeVisible();
    }
  });
  expect(prefill).toBe(LOCAL_STORY_PREFILL);
  await fillMessage(page, INPUT);

  expect(blockedWrites).toEqual([]);
});

test.describe('paid generation', () => {
  test.use({ actionTimeout: 30_000, contextOptions: { recordHar: { path: `${OUTPUT_DIR}/leo-network.har` } } });

  test('Avatar Video Creator creates a local story reel', async ({ page, request }, testInfo) => {
    test.skip(process.env.LEO_VIDEO_RUN !== '1', 'Each run renders a paid video: set LEO_VIDEO_RUN=1');
    test.setTimeout(GENERATION_TIMEOUT + 10 * 60_000);
    await runScenarioThroughUi({ page, request, testInfo }, CHEYENNE, { input: async () => INPUT, answer: scriptedAnswer });
  });
});
