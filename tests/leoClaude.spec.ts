import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { briefWithStory, decideForCard, expectRealSources, findLocalStory, pickStoryArea, writeLeoPrompt } from './leoClaude';
import { CHEYENNE, LOCAL_STORY_PREFILL } from './leoScenario';
import { loadScenario } from './scenario';

// Leo's real questions from the cancelled farmers-market run on 2026-09-28
const [cityQuestion, factCheckFlag, scriptApproval] = JSON.parse(
  readFileSync('tests/fixtures/leo-questions-2026-09-28.json', 'utf8'),
) as string[];

// The approval cards as Leo rendered them in paid run 1 (from its screenshots)
const RENDER_APPROVAL = `NEEDS YOUR APPROVAL
The story: Cheyenne Frontier Days — first held in Cheyenne in 1897, the "Daddy of 'em All," and an invite to buyers thinking about calling Cheyenne home
The look: bold-news, with "Daddy of 'Em All — Est. 1897" on the poster
Length: about 17 seconds (the approved script read at its natural pace)
The voice: stock presenter voice
Captions: burned in`;
const VIDEO_READY = `NEEDS YOUR APPROVAL
Your reel is ready — 18 seconds.`;
const brief = CHEYENNE.brief;

test('Claude writes a prompt that pre-answers what Leo asks for', async () => {
  const { message, script } = await writeLeoPrompt(brief, LOCAL_STORY_PREFILL);
  test.info().annotations.push({ type: 'prompt', description: message });
  expect(message.startsWith(LOCAL_STORY_PREFILL)).toBe(true);
  expect(message).toContain('Cheyenne');
  expect(message).toContain('1897');
  expect(message, 'The script is in the message').toContain(script);
  // The message may warn Leo not to say "every year"; only the script itself must not claim it
  expect(script).not.toMatch(/every year|annual/i);
});

test('Claude stops when Leo asks about a different story', async () => {
  // Leo's real question was about the farmers market, not the story in Claude's brief
  const answer = await decideForCard(brief, { status: 'WAITING_ON_INPUT', text: cityQuestion, buttons: [] });
  expect(answer.action).toBe('stop');
});

test('Claude answers a missing-city question with the city', async () => {
  const question = cityQuestion
    .replace(/new downtown farmers market/g, 'Cheyenne Frontier Days story')
    .replace(/opening details \(this Saturday, 8am–noon\)/, 'details');
  const answer = await decideForCard(brief, { status: 'WAITING_ON_INPUT', text: question, buttons: [] });
  expect(answer).toMatchObject({ action: 'reply' });
  expect(answer.action === 'reply' && answer.text).toMatch(/Cheyenne/);
});

test('Claude does not vouch for facts outside its brief', async () => {
  const answer = await decideForCard(brief, { status: 'WAITING_ON_INPUT', text: factCheckFlag, buttons: [] });
  test.info().annotations.push({ type: 'decision', description: JSON.stringify(answer) });
  expect(answer.action === 'reply' ? answer.text : 'stopped').not.toMatch(/this Saturday|8 ?am|brand-new/i);
});

test('Claude will not approve a script for a different story', async () => {
  const answer = await decideForCard(brief, { status: 'WAITING_ON_INPUT', text: scriptApproval, buttons: [] });
  test.info().annotations.push({ type: 'decision', description: JSON.stringify(answer) });
  expect(answer.action === 'reply' ? answer.text : 'stopped').not.toMatch(/^(approved|yes|looks good)/i);
});

test('Claude approves the render when the plan matches the brief', async () => {
  const card = { status: 'WAITING_ON_HUMAN', text: RENDER_APPROVAL, buttons: ['Approve'] };
  expect(await decideForCard(brief, card)).toEqual({ action: 'click', button: 'Approve' });
});

test('Claude refuses to approve a render for the wrong story', async () => {
  const wrongStory = RENDER_APPROVAL.replace(/Cheyenne Frontier Days[^\n]*/, 'A new farmers market opens downtown this Saturday');
  const answer = await decideForCard(brief, { status: 'WAITING_ON_HUMAN', text: wrongStory, buttons: ['Approve'] });
  expect(answer.action).toBe('stop');
});

test('Claude completes the task once the video is ready', async () => {
  const history = [{ card: RENDER_APPROVAL, answer: { action: 'click', button: 'Approve' } as const }];
  const card = { status: 'WAITING_ON_HUMAN', text: VIDEO_READY, buttons: ['Complete Task'] };
  expect(await decideForCard(brief, card, history)).toEqual({ action: 'click', button: 'Complete Task' });
});

test('Claude finds a real local story with sources that load', async ({ request }) => {
  const scenario = loadScenario('local-story-reel');
  const area = pickStoryArea(scenario.research!.localStoryIn);
  test.info().annotations.push({ type: 'area', description: area });
  const story = await findLocalStory(area);
  test.info().annotations.push({ type: 'story', description: JSON.stringify(story) });
  await expectRealSources(request, story);

  const { message } = await writeLeoPrompt(briefWithStory(scenario.brief, story), LOCAL_STORY_PREFILL);
  test.info().annotations.push({ type: 'prompt', description: message });
  expect(message.startsWith(LOCAL_STORY_PREFILL)).toBe(true);
  expect(message).toMatch(new RegExp(story.city.split(',')[0], 'i'));
});
