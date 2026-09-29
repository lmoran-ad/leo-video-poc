import { appendFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { loginToLeo, pendingActions } from './leoApi';
import { FAILURE, GENERATION_TIMEOUT, INPUT, MAX_QUESTIONS, REPLY, SUCCESS } from './leoScenario';
import { expectArtifactInS3, type Artifact } from './s3Artifact';

const POLL_INTERVAL = 15_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('API: logs in with password + TOTP and reads the Leo conversation', async ({ playwright }) => {
  const leo = await loginToLeo(playwright.request);
  const direct = await leo.get('/api/v1/conversations/direct');
  expect(direct.ok(), 'Leo accepted the Keymaker token').toBe(true);
  expect((await direct.json()).conversation_id).toMatch(UUID);
});

test('API: Avatar Video Creator renders a local story reel into S3', async ({ playwright, request }, testInfo) => {
  test.skip(process.env.LEO_VIDEO_API_RUN !== '1', 'Each run renders a paid video: set LEO_VIDEO_API_RUN=1');
  test.setTimeout(GENERATION_TIMEOUT + 5 * 60_000);

  const startedAt = Date.now();
  const note = (type: string, description: string) => {
    testInfo.annotations.push({ type, description });
    appendFileSync(testInfo.outputPath('leo-events.jsonl'), `${JSON.stringify({ ms: Date.now() - startedAt, type, description })}\n`);
  };
  const leo = await loginToLeo(playwright.request);

  const { conversation_id: conversationId } = await (await leo.get('/api/v1/conversations/direct')).json();
  const taskIdsInConversation = async () => {
    const { items } = await (await leo.get(`/api/v1/conversations/${conversationId}/messages?limit=20&offset=0`)).json();
    return new Set<string>(items.map((message: any) => message.metadata?.task?.task_id).filter(Boolean));
  };
  const earlierTasks = await taskIdsInConversation();

  const sent = await leo.post('/api/chat/messages', { data: { content: INPUT, conversation_id: conversationId } });
  expect(sent.ok(), 'Leo accepted the message').toBe(true);

  let taskId = '';
  await expect
    .poll(async () => (taskId = [...(await taskIdsInConversation())].find((id) => !earlierTasks.has(id)) ?? ''), {
      message: 'Leo created a task for the message',
      timeout: 120_000,
      intervals: [3_000],
    })
    .toMatch(UUID);
  note('taskId', taskId);

  // Keyed by clarification step id / tool_call_id, so a lagging status can never trigger a second paid approval
  const answered = new Set<string>();
  let questions = 0;
  let detail: any = {};
  const deadline = Date.now() + GENERATION_TIMEOUT;
  while (Date.now() < deadline) {
    detail = await (await leo.get(`/api/v1/tasks/${taskId}/detail`)).json();
    note('status', detail.status);
    if (SUCCESS.includes(detail.status) || FAILURE.includes(detail.status)) break;

    for (const action of pendingActions(detail.status, detail.steps ?? []).filter((a) => !answered.has(a.key))) {
      if (action.kind === 'clarify') questions++;
      expect(questions, 'Leo kept asking questions; change INPUT, not the code').toBeLessThanOrEqual(MAX_QUESTIONS);
      const response =
        action.kind === 'clarify'
          ? await leo.post(`/api/v1/tasks/${taskId}/clarify`, { data: { answer: REPLY } })
          : await leo.post(`/api/v1/tasks/${taskId}/approve`, {
              data: { decisions: [{ tool_call_id: action.key, approved: true }] },
            });
      note(action.kind, `${action.summary} -> ${response.status()}`);
      // 409 means the UI or an earlier poll already resolved it, which is fine
      expect([200, 409], `Leo accepted the ${action.kind}`).toContain(response.status());
      answered.add(action.key);
    }
    await sleep(POLL_INTERVAL);
  }

  expect(FAILURE, `Leo ended the task as ${detail.status}`).not.toContain(detail.status);
  expect(SUCCESS, `Task still ${detail.status} after ${GENERATION_TIMEOUT / 60_000} minutes`).toContain(detail.status);

  // The rendered video is attached to the subtask; the parent's artifact list stays empty
  const childIds = [...new Set([...JSON.stringify(detail).matchAll(/"child_task_id":"([0-9a-f-]{36})"/g)].map((m) => m[1]))];
  note('childTasks', childIds.join(', '));
  const artifacts: Artifact[] = [];
  for (const id of [taskId, ...childIds]) {
    const list = await (await leo.get(`/api/v1/tasks/${id}/artifacts`)).json();
    artifacts.push(...(Array.isArray(list) ? list : []).map((artifact: Artifact) => ({ ...artifact, taskId: id })));
  }
  await testInfo.attach('artifacts.json', { body: JSON.stringify(artifacts, null, 2), contentType: 'application/json' });

  const video = artifacts.find((artifact) => artifact.format === 'mp4');
  expect(video, 'Leo lists an mp4 artifact').toBeTruthy();
  note('videoArtifact', `${video!.filename} -> ${new URL(video!.url).pathname}`);
  note('s3', JSON.stringify(await expectArtifactInS3(request, video!, startedAt)));
});
