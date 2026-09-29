import { expect, type APIRequestContext } from '@playwright/test';
import { totp } from './totp';

const KEYMAKER = 'https://keymaker.therealbrokerage.com';
const ARI = 'https://ari.therealbrokerage.com';
// The AWS load balancer in front of Keymaker returns 403 to Playwright's default user agent
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';
const RESOLVED_STEP_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);

type PlaywrightRequest = { newContext: (options: object) => Promise<APIRequestContext> };
type TaskStep = {
  id: string;
  kind: string;
  ordinal: number;
  status?: string;
  summary?: string;
  payload?: Record<string, unknown> | null;
};
export type PendingAction = { kind: 'clarify' | 'approve'; key: string; summary: string };

// The same two calls the Bolt login page makes, so no browser session is needed
export async function loginToLeo(request: PlaywrightRequest) {
  const { LEO_USERNAME, LEO_PASSWORD, LEO_TOTP_SECRET } = process.env;
  expect(LEO_USERNAME && LEO_PASSWORD && LEO_TOTP_SECRET, 'Set LEO_USERNAME, LEO_PASSWORD, LEO_TOTP_SECRET').toBeTruthy();

  const keymaker = await request.newContext({ baseURL: KEYMAKER, extraHTTPHeaders: { 'User-Agent': BROWSER_UA } });
  const signin = await keymaker.post('/api/v1/auth/signin', {
    data: { usernameOrEmail: LEO_USERNAME, password: LEO_PASSWORD },
  });
  const signinBody = await signin.json().catch(() => ({}));
  expect(signin.ok(), `Keymaker rejected the password: ${signin.status()} ${signinBody.errorMessage ?? ''}`).toBe(true);

  const mfa = await keymaker.post('/api/v1/mfa/signin-with-mfa', {
    headers: { Authorization: `Bearer ${signinBody.accessToken}` },
    data: { code: totp(LEO_TOTP_SECRET!) },
  });
  const mfaBody = await mfa.json().catch(() => ({}));
  expect(mfa.ok(), `Keymaker rejected the TOTP code: ${mfa.status()} ${mfaBody.errorMessage ?? ''}`).toBe(true);
  const { accessToken } = mfaBody;
  await keymaker.dispose();

  return request.newContext({
    baseURL: ARI,
    extraHTTPHeaders: { Authorization: `Bearer ${accessToken}`, 'User-Agent': BROWSER_UA, 'x-real-app-name': 'airm-web' },
  });
}

const toolCallId = (step: TaskStep) =>
  typeof step.payload?.tool_call_id === 'string' ? step.payload.tool_call_id : null;

// Mirrors airm's findPendingApprovals / findLatestClarification so the API answers exactly what the UI would show
export function pendingActions(status: string, steps: TaskStep[]): PendingAction[] {
  if (status === 'WAITING_ON_INPUT') {
    const open = steps
      .filter((step) => step.kind === 'CLARIFICATION_REQUEST' && typeof step.payload?.answer !== 'string')
      .sort((a, b) => b.ordinal - a.ordinal)[0];
    return open ? [{ kind: 'clarify', key: open.id, summary: open.summary ?? '' }] : [];
  }
  if (status !== 'WAITING_ON_HUMAN') return [];

  const lastWait = new Map<string, number>();
  for (const step of steps.filter((s) => s.kind === 'WAIT_FOR_HUMAN')) {
    const id = toolCallId(step);
    if (id && step.ordinal > (lastWait.get(id) ?? -Infinity)) lastWait.set(id, step.ordinal);
  }
  const requests = new Map<string, TaskStep>();
  for (const step of steps.filter((s) => s.kind === 'APPROVAL_REQUEST')) {
    const id = toolCallId(step);
    if (id && step.ordinal > (requests.get(id)?.ordinal ?? -Infinity)) requests.set(id, step);
  }
  return [...requests.entries()]
    .filter(([id, step]) => !RESOLVED_STEP_STATUSES.has(step.status ?? '') && (lastWait.get(id) ?? -Infinity) < step.ordinal)
    .map(([id, step]) => ({ kind: 'approve', key: id, summary: String(step.payload?.tool_name ?? '') }));
}
