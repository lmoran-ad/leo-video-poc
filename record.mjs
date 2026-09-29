import { chromium } from '@playwright/test';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readBody } from './redact.mjs';

const startUrl = process.argv[2] ?? 'https://airm.therealbrokerage.com/leo/office';
const runDir = join('runs', new Date().toISOString().replace(/[:.]/g, '-'));
const snapshotDir = join(runDir, 'snapshots');
const eventsFile = join(runDir, 'events.jsonl');
mkdirSync(snapshotDir, { recursive: true });
mkdirSync('auth', { recursive: true });

const LOGGED_TYPES = new Set(['xhr', 'fetch', 'document', 'eventsource']);
const MAX_TEXT = 20_000;
const startedAt = Date.now();
let step = 0;

function log(type, fields) {
  const line = JSON.stringify({ ms: Date.now() - startedAt, type, ...fields });
  appendFileSync(eventsFile, `${line}\n`);
  console.log(line.slice(0, 240));
}

async function snapshot(page, label) {
  if (page.isClosed()) return;
  const base = join(snapshotDir, `${String(++step).padStart(3, '0')}-${label}`);
  await Promise.all([
    page.content().then((html) => writeFileSync(`${base}.html`, html)),
    page.screenshot({ path: `${base}.png` }),
  ]).catch((error) => log('snapshot-failed', { label, error: error.message }));
}

const SSE_SNAPSHOT_GAP = 3000;
const TICK_INTERVAL = 15_000;

async function watchPage(page) {
  let lastSseSnapshot = 0;
  // SSE bodies only resolve when the stream ends, so read each message live from CDP
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  cdp.on('Network.eventSourceMessageReceived', ({ eventName, data }) => {
    log('sse', { eventName, data: readBody(data) });
    if (Date.now() - lastSseSnapshot < SSE_SNAPSHOT_GAP) return;
    lastSseSnapshot = Date.now();
    setTimeout(() => snapshot(page, 'sse'), 500);
  });
  const tick = setInterval(() => snapshot(page, 'tick'), TICK_INTERVAL);
  page.on('close', () => clearInterval(tick));
  page.on('load', () => snapshot(page, 'load'));
  page.on('framenavigated', (frame) => frame === page.mainFrame() && log('navigate', { url: frame.url() }));
  page.on('console', (message) => message.type() === 'error' && log('console-error', { text: message.text() }));
  page.on('pageerror', (error) => log('page-error', { message: error.message }));
  page.on('websocket', (socket) => {
    log('websocket', { url: socket.url() });
    socket.on('framereceived', ({ payload }) => log('ws-in', { url: socket.url(), payload: readBody(String(payload)) }));
    socket.on('framesent', ({ payload }) => log('ws-out', { url: socket.url(), payload: readBody(String(payload)) }));
  });
  page.on('close', () => context.pages().length === 0 && finish());
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: process.env.HEADLESS === '1',
  args: ['--start-maximized'],
});
const context = await browser.newContext({
  viewport: null,
  recordHar: { path: join(runDir, 'network.har') },
});
await context.tracing.start({ screenshots: true, snapshots: true });

await context.exposeBinding('__leoLog', async ({ page }, event) => {
  log('user', event);
  await page.waitForTimeout(1500);
  await snapshot(page, event.kind);
});
await context.addInitScript(() => {
  const SECRET_FIELD = /pass|otp|code|token|secret/i;
  const describe = (element) => ({
    tag: element.tagName.toLowerCase(),
    role: element.getAttribute('role') ?? undefined,
    name: (
      element.getAttribute('aria-label') ||
      element.innerText?.trim() ||
      element.getAttribute('placeholder') ||
      element.getAttribute('name') ||
      ''
    ).slice(0, 80),
    id: element.id || undefined,
    testId: element.closest('[data-testid]')?.getAttribute('data-testid') ?? undefined,
    type: element.getAttribute('type') ?? undefined,
  });
  const isSecret = (element) =>
    element.type === 'password' ||
    element.autocomplete === 'one-time-code' ||
    SECRET_FIELD.test(`${element.name} ${element.id} ${element.placeholder}`);

  addEventListener(
    'click',
    (event) => {
      const target = event.target.closest('button, a, input, label, [role], [data-testid]') ?? event.target;
      window.__leoLog({ kind: 'click', target: describe(target) });
    },
    true,
  );
  addEventListener(
    'change',
    (event) =>
      window.__leoLog({
        kind: 'input',
        target: describe(event.target),
        value: isSecret(event.target) ? '[redacted]' : event.target.value,
      }),
    true,
  );
  addEventListener(
    'keydown',
    (event) => event.key === 'Enter' && window.__leoLog({ kind: 'enter', target: describe(event.target) }),
    true,
  );
});

context.on('page', watchPage);
context.on('request', (request) => {
  if (!LOGGED_TYPES.has(request.resourceType())) return;
  log('request', { method: request.method(), url: request.url(), body: readBody(request.postData()) });
});
context.on('requestfailed', (request) => log('request-failed', { url: request.url(), error: request.failure()?.errorText }));
context.on('response', async (response) => {
  const type = response.request().resourceType();
  if (!LOGGED_TYPES.has(type)) return;
  const contentType = response.headers()['content-type'] ?? '';
  const text = contentType.includes('json') || contentType.includes('event-stream')
    ? await response.text().catch((error) => `[body unavailable: ${error.message}]`)
    : undefined;
  log('response', {
    status: response.status(),
    url: response.url(),
    contentType,
    body: contentType.includes('json') ? readBody(text) : text?.slice(0, MAX_TEXT),
  });
});

let finishing;
function finish() {
  finishing ??= (async () => {
    await context.storageState({ path: join('auth', 'state.json') });
    await context.tracing.stop({ path: join(runDir, 'trace.zip') });
    await context.close();
    console.log(`Saved ${runDir} and auth/state.json`);
    // browser.close takes ~2 min on this machine; everything is already on disk
    process.exit(0);
  })();
  return finishing;
}
process.on('SIGINT', finish);

const page = await context.newPage();
await page.goto(startUrl);
console.log(`Recording to ${runDir}. Close the browser window to finish.`);
