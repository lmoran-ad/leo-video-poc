import { appendFileSync } from 'node:fs';
import { expect, test, type APIRequestContext, type Page, type Response, type TestInfo } from '@playwright/test';
import { readBody } from '../redact.mjs';
import { FAILURE, GENERATION_TIMEOUT, MAX_QUESTIONS, SUCCESS } from './leoScenario';
import { expectArtifactInS3, type Artifact } from './s3Artifact';
import type { Scenario } from './scenario';

const POLL_INTERVAL = 20_000;
const TASK_PATH = /ari\.therealbrokerage\.com\/api\/v1\/tasks\/([0-9a-f-]{36})\/(detail|artifacts)/;
const VIDEO_FORMATS = ['mp4', 'mov', 'webm'];

export type LeoCard = { status: string; text: string; buttons: string[] };
export type LeoAnswer = { action: 'reply'; text: string } | { action: 'click'; button: string } | { action: 'stop'; reason: string };
export type Answerer = (card: LeoCard) => Promise<LeoAnswer>;
export type LeoRun = { taskId: string; detail: any; cards: string[]; artifacts: Artifact[] };

// Opens the scenario's office agent (and starter option) and returns whatever Leo prefilled
export async function openAgent(page: Page, scenario: Scenario, onAgentOpen?: () => Promise<void>) {
  // The intro's "Next" and "Got it" share one test id, so the handler must fire once per step
  await page.addLocatorHandler(page.getByTestId('beta-support-intro-cta'), (cta) => cta.click(), {
    noWaitAfter: true,
  });
  await page.goto('/leo/office');
  await page.getByRole('button', { name: scenario.agent }).click();
  await onAgentOpen?.();
  const textbox = page.getByTestId('send-message-textbox');
  if (scenario.option) {
    await page.getByRole('button', { name: new RegExp(`^${scenario.option}`) }).click();
    await expect(textbox).not.toHaveValue('');
  }
  return textbox.inputValue();
}

export async function fillMessage(page: Page, input: string) {
  await page.getByTestId('send-message-textbox').fill(input);
  await expect(page.getByTestId('send-message-button')).toBeEnabled();
}

export async function runScenarioThroughUi(
  { page, request, testInfo }: { page: Page; request: APIRequestContext; testInfo: TestInfo },
  scenario: Scenario,
  { input, answer }: { input: (prefill: string) => Promise<string>; answer: Answerer },
): Promise<LeoRun> {
  const eventsFile = testInfo.outputPath('leo-events.jsonl');
  const startedAt = Date.now();
  const details = new Map<string, any>();
  const artifactLists = new Map<string, any>();
  const cards: string[] = [];
  let shot = 0;
  const screenshot = (label: string) =>
    page.screenshot({ path: testInfo.outputPath(`${String(++shot).padStart(3, '0')}-${label}.png`) });
  const note = (type: string, description: string) => {
    testInfo.annotations.push({ type, description });
    appendFileSync(eventsFile, `${JSON.stringify({ ms: Date.now() - startedAt, type, description })}\n`);
  };

  page.on('response', async (response: Response) => {
    if (!response.url().includes('ari.therealbrokerage.com/api/')) return;
    const text = await response.text().catch((error: Error) => `[body unavailable: ${error.message}]`);
    const body = readBody(text);
    appendFileSync(
      eventsFile,
      `${JSON.stringify({ ms: Date.now() - startedAt, method: response.request().method(), status: response.status(), url: response.url(), body })}\n`,
    );
    const [, taskId, kind] = response.url().match(TASK_PATH) ?? [];
    if (kind === 'detail') details.set(taskId, body);
    if (kind === 'artifacts') artifactLists.set(taskId, body);
  });

  const message = await input(await openAgent(page, scenario));
  note('input', message);
  await fillMessage(page, message);
  await screenshot('ready-to-send');

  const sendTime = new Date(Date.now() - 60_000).toISOString();
  const sent = page.waitForResponse((r) => r.url().endsWith('/api/chat/messages') && r.request().method() === 'POST');
  const taskMessage = page.waitForResponse(
    async (r) =>
      /\/conversations\/[0-9a-f-]{36}\/messages/.test(r.url()) &&
      // A non-JSON response must not reject this wait after the paid Send has gone out
      ((await r.json().catch(() => ({}))).items ?? []).some(
        (m: any) => m.metadata?.task?.task_id && m.created_at > sendTime,
      ),
    { timeout: 120_000 },
  );
  await page.getByTestId('send-message-button').click();
  expect((await sent).ok(), 'Leo accepted the message').toBe(true);

  const items: any[] = (await (await taskMessage).json()).items;
  const taskId: string = items.find((m) => m.metadata?.task?.task_id && m.created_at > sendTime).metadata.task.task_id;
  note('taskId', taskId);

  let lastPrompt = '';
  let questions = 0;
  let status = '';
  const deadline = Date.now() + GENERATION_TIMEOUT;
  while (Date.now() < deadline) {
    const detail = page.waitForResponse((r) => r.url().includes(`/tasks/${taskId}/detail`));
    await page.goto(`/leo?task=${taskId}`);
    status = (await (await detail).json()).status;
    await screenshot(status.toLowerCase());
    note('status', status);
    if (SUCCESS.includes(status) || FAILURE.includes(status)) break;

    // WAITING_ON_INPUT is a question to answer; WAITING_ON_HUMAN is an approval card
    if (status === 'WAITING_ON_INPUT' || status === 'WAITING_ON_HUMAN') {
      const prompt = page.getByText(/leo needs your input|needs your approval/i).first();
      await expect(prompt).toBeVisible({ timeout: 30_000 });
      const promptText = (await prompt.locator('..').innerText()).slice(0, 4000);
      // Status can lag a poll behind our click; answering the same card twice could start a second paid render
      if (promptText === lastPrompt) {
        note('already-answered', status);
        await page.waitForTimeout(POLL_INTERVAL);
        continue;
      }
      // Only questions count: approval cards are answered once each, and a real AI conversation needs both
      if (status === 'WAITING_ON_INPUT') questions++;
      expect(questions, 'Leo kept asking questions; change the scenario, not the code').toBeLessThanOrEqual(MAX_QUESTIONS);
      note('question', promptText);
      cards.push(promptText);
      const summary = promptText.replace(/^(leo needs your input|needs your approval)\s*/i, '').replace(/\s+/g, ' ');

      // One report step per card, so each run reads as Leo's question followed by the answer it got
      await test.step(`Leo #${cards.length} (${status}): ${summary.slice(0, 120)}`, async () => {
        const buttons = [];
        for (const name of scenario.allowedButtons) {
          if (await page.getByRole('button', { name: new RegExp(`^${name}`) }).isVisible()) buttons.push(name);
        }
        const decision = await answer({ status, text: promptText, buttons });
        note('decision', JSON.stringify(decision));
        const described =
          decision.action === 'click' ? `click ${decision.button}` : decision.action === 'reply' ? `reply "${decision.text}"` : `stop: ${decision.reason}`;
        await test.step(`Answer: ${described.slice(0, 200)}`, async () => {
          expect(decision.action, decision.action === 'stop' ? `Stopped before answering: ${decision.reason}` : '').not.toBe('stop');

          const answered = page.waitForResponse(
            // Answers post to /clarify or /approve; any POST counts so a renamed endpoint is still caught
            (r) => r.url().includes('ari.therealbrokerage.com/api/') && r.request().method() === 'POST',
          );
          if (decision.action === 'click') {
            await page.getByRole('button', { name: new RegExp(`^${decision.button}`) }).click();
          } else if (decision.action === 'reply') {
            await page.getByPlaceholder(/Type your answer for Leo/).fill(decision.text);
            await page.getByRole('button', { name: 'Send Reply' }).click();
          }
          const response = await answered;
          note('answered', `${response.request().method()} ${response.url()} -> ${response.status()}`);
          expect(response.ok(), 'Leo accepted the answer').toBe(true);
        });
      });
      lastPrompt = promptText;
    }
    await page.waitForTimeout(POLL_INTERVAL);
  }

  expect(FAILURE, `Leo ended the task as ${status}`).not.toContain(status);
  expect(SUCCESS, `Task still ${status} after ${GENERATION_TIMEOUT / 60_000} minutes`).toContain(status);

  const childIds = [...JSON.stringify(details.get(taskId)).matchAll(/"child_task_id":"([0-9a-f-]{36})"/g)].map((m) => m[1]);
  note('childTasks', childIds.join(', '));
  for (const id of new Set([taskId, ...childIds])) {
    const artifactResponse = page.waitForResponse((r) => r.url().includes(`/tasks/${id}/artifacts`), { timeout: 15_000 });
    await page.goto(`/leo?task=${id}`);
    await artifactResponse.then(
      () => screenshot(`artifacts-${id.slice(0, 8)}`),
      () => note('no-artifacts-request', id),
    );
  }
  // Produced files usually hang off a subtask; the parent's artifact list is often empty
  const artifacts: Artifact[] = [...artifactLists].flatMap(([id, list]) =>
    (Array.isArray(list) ? list : []).map((artifact: Artifact) => ({ ...artifact, taskId: id })),
  );
  await testInfo.attach('artifacts.json', { body: JSON.stringify(artifacts, null, 2), contentType: 'application/json' });

  const { artifactFormat } = scenario.expect;
  if (artifactFormat) {
    const produced = artifacts.find((artifact) => artifact.format === artifactFormat);
    expect(produced, `Leo lists a ${artifactFormat} artifact`).toBeTruthy();
    note('artifact', `${produced!.filename} -> ${new URL(produced!.url).pathname}`);
    note('s3', JSON.stringify(await expectArtifactInS3(request, produced!, startedAt)));

    if (VIDEO_FORMATS.includes(artifactFormat)) {
      await page.goto(`/leo?task=${taskId}`);
      const player = page.locator('video').first();
      await expect(player).toBeAttached({ timeout: 15_000 });
      const playerSrc = await player.evaluate((element: HTMLVideoElement) => element.currentSrc || element.src);
      expect(new URL(playerSrc).pathname, 'The task page plays the S3 file').toBe(new URL(produced!.url).pathname);
    }
  }
  await screenshot('finished');
  return { taskId, detail: details.get(taskId), cards, artifacts };
}
