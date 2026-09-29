import { expect, test } from '@playwright/test';
import { pendingActions } from './leoApi';

const approval = (ordinal: number, toolCallId: string, status = 'RUNNING') => ({
  id: `approval-${ordinal}`,
  kind: 'APPROVAL_REQUEST',
  ordinal,
  status,
  payload: { tool_call_id: toolCallId, tool_name: 'create_presenter_video' },
});
const waitForHuman = (ordinal: number, toolCallId: string) => ({
  id: `wait-${ordinal}`,
  kind: 'WAIT_FOR_HUMAN',
  ordinal,
  payload: { tool_call_id: toolCallId },
});

test('an open approval request is returned once per tool call', () => {
  const actions = pendingActions('WAITING_ON_HUMAN', [approval(1, 'call-a'), approval(2, 'call-a')]);
  expect(actions).toEqual([{ kind: 'approve', key: 'call-a', summary: 'create_presenter_video' }]);
});

test('an approval followed by a newer wait step is already handled', () => {
  expect(pendingActions('WAITING_ON_HUMAN', [approval(1, 'call-a'), waitForHuman(2, 'call-a')])).toEqual([]);
});

test('a new approval after an earlier wait step is still open', () => {
  const steps = [waitForHuman(1, 'call-a'), approval(2, 'call-a'), approval(3, 'call-b', 'SUCCEEDED')];
  expect(pendingActions('WAITING_ON_HUMAN', steps).map((a) => a.key)).toEqual(['call-a']);
});

test('nothing is answered while Leo is working', () => {
  expect(pendingActions('WAITING_ON_CHILD', [approval(1, 'call-a')])).toEqual([]);
});
