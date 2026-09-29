# leo-video-poc

Playwright end-to-end tests for **Leo's Avatar Video Creator** in the AiRM app.

Leo is an AI assistant: every run can ask different questions, fact-check the input and show
approval cards before it renders a video. These tests drive that flow from a prompt to a finished
video and prove the video exists in storage. The same scenario is covered three ways:

| Approach | Spec | How it drives Leo | How it answers Leo |
|---|---|---|---|
| Scripted UI | `tests/leo-video.spec.ts` | Browser, like a user | Fixed reply; clicks the approval card shown |
| API | `tests/leo-video.api.spec.ts` | Leo's REST API, no browser | Fixed reply; the app's own approval logic |
| AI-driven | `tests/leo-scenario.spec.ts` | Browser, like a user | Claude reads each card and decides |

> **Cost warning:** a full run creates a real video and is billed. Only the `paid:*` scripts do this,
> and each asks for confirmation first. Everything else is free or uses Claude only.

---

## Prerequisites

- Node.js 24
- Google Chrome (the tests launch the installed Chrome)
- A Real account with access to Leo's Avatar Video Creator, dedicated to testing
- For the AI-driven tests: either an Anthropic API key or the Claude Code CLI signed in

```bash
npm install
cp .env.example .env
```

Then fill in `.env` as described below. `.env`, `auth/`, `runs/`, `test-results/` and
`playwright-report/` are git-ignored; never commit them.

---

## Secrets

All secrets live in `.env`, which is git-ignored. The project ships with every secret value
removed: `.env` lists the keys with empty values, so fill them in before running anything that signs
in. No secret is stored in the code, scenarios, fixtures or this README.

| Variable | Required | What it is | How to get it |
|---|---|---|---|
| `LEO_USERNAME` | Yes | Username or email of the test account | The test account's owner |
| `LEO_PASSWORD` | Yes | Password of the test account | The test account's owner. Wrap it in single quotes: an unquoted `#` starts a comment and silently cuts the password short |
| `LEO_TOTP_SECRET` | Yes | Base32 secret of the account's authenticator-app 2FA | See [Two-factor authentication](#two-factor-authentication) |
| `ANTHROPIC_API_KEY` | No | Key for the AI-driven tests | [platform.claude.com](https://platform.claude.com) → API Keys, or your team's Anthropic admin. Without it, the tests use the signed-in `claude` CLI instead |
| `LEO_STORY_AREA` | No | Pins the city for the researched reel, e.g. `"Boise, Idaho"` | Not a secret. Leave it out for a random city |
| `LEO_S3_HOST` | Yes, for full runs | Host of the S3 bucket where Leo stores produced files; every full run checks the video is served from it | Internal, not a secret. Take it from the host part of any artifact URL: open a finished Leo task, and the artifact list (`GET /api/v1/tasks/:id/artifacts`) shows links of the form `https://<LEO_S3_HOST>/ai_agent/tasks/...`. Or ask the Leo team |

### What each secret was, and its status

| Secret | What was used | Status | To restore |
|---|---|---|---|
| `LEO_USERNAME` | The username of a Real agent account set aside for these tests (a Bolt login with the Leo / AiRM role) | Removed from `.env` | Ask the account's owner |
| `LEO_PASSWORD` | That account's Bolt password (it contains a `#`, hence the quotes) | Removed from `.env` | Ask the account's owner, or reset it through Bolt's "Trouble logging in?" |
| `LEO_TOTP_SECRET` | The 32-character base32 secret created when the account's 2FA was switched from SMS to an authenticator app | Removed from `.env`. It was exposed during development, so treat it as compromised | Re-enroll 2FA as below; that issues a new secret and invalidates the old one |
| `ANTHROPIC_API_KEY` | Never set. The AI-driven tests ran through the Claude Code CLI login instead | Not in use | Only needed to run without the CLI |

The TOTP secret can't be looked up after enrollment: Bolt shows it once, inside the QR code. If it
is lost, re-enrolling is the only way to get a new one.

### Two-factor authentication

The login requires a 6-digit code. The tests generate it themselves from the account's
authenticator secret, so no phone is needed during a run.

1. **Switch the account to an authenticator app.** Sign in to Bolt as the test account, then go to
   **Profile → Security settings → Two-factor authentication** and choose **Authenticator app**.
   If it is already on, switch to SMS and back to get a new QR code.
2. **Get the secret from the QR code.** Bolt shows only a QR code. It encodes a link of the form
   `otpauth://totp/...?secret=ABCD...&digits=6`; the part after `secret=` is `LEO_TOTP_SECRET`.
   Two ways to read it:
   - Run `npm run record`, complete the enrollment in the browser that opens, and close the window.
     The link is in the response to `GET /api/v1/mfa/mfa-qr-code` inside
     `runs/<timestamp>/network.har`. The recorder's own event log redacts it.
   - Or scan the QR code with any QR reader that shows the raw text.
3. **Finish enrollment in Bolt** with a code from Google Authenticator (scan the same QR code), so
   a person can still sign in by hand.
4. **Save the secret** as `LEO_TOTP_SECRET` in `.env`, then check it with `npm run test:login-ui`.

Re-enrolling generates a new secret and invalidates the old one. Do it whenever the secret may
have been exposed, and update `.env` and the authenticator app together.

How the tests use it:

- **Browser tests:** `tests/auth.setup.ts` signs in with the username, password and a code from
  `tests/totp.ts`, then saves the session to `auth/state.json` for the tests that follow.
- **API tests:** `tests/leoApi.ts` calls Keymaker's `/api/v1/auth/signin` and
  `/api/v1/mfa/signin-with-mfa` directly and uses the returned token for Leo's API.

Sessions expire after about 40 minutes, so each run signs in fresh.

---

## Running the tests

| Script | What it does | Cost |
|---|---|---|
| `npm run test:totp` | TOTP generator against the RFC 6238 test vectors | Free |
| `npm run test:approvals` | Unit tests for the API's pending-approval logic | Free |
| `npm run test:login-ui` | Browser sign-in with 2FA | Free |
| `npm run test:login-api` | API sign-in with 2FA, then reads the Leo conversation | Free |
| `npm run test:pre-send` | Scripted UI up to the Send button; all writes to Leo are blocked | Free |
| `npm run test:free` | All free tests above | Free |
| `npm run test:claude-decisions` | Claude's decisions on recorded Leo questions and approval cards | Claude usage |
| `npm run test:claude-research` | Claude finds a real local story; every source URL must load | Claude usage |
| `npm run test:claude` | Both Claude test sets | Claude usage |
| `npm run paid:ui` | Scripted UI, full run | **1 video** |
| `npm run paid:api` | API, full run | **1 video** |
| `npm run paid:ai` | AI-driven run of the scenario in `LEO_SCENARIO` (default `local-story-reel`) | **1 video** + Claude usage |
| `npm run report` | Opens the last HTML report | Free |
| `npm run record` | Opens Chrome and records a manual session (clicks, API calls, screenshots) | Free |

`paid:*` scripts ask for confirmation. Pass `-- --yes` to skip it, or `-- --list` to show which tests
would run without running them. Run paid scripts one at a time.

### Output

- Free runs write to `test-results/`, which Playwright clears on every run.
- Paid runs write to `runs/paid-<timestamp>/` so later runs can't delete them: a screenshot per
  status check, `leo-events.jsonl` (every Leo API response, with credentials redacted),
  `leo-network.har`, a video of the run and `artifacts.json`.
- `runs/` and `auth/` contain session data. Delete them when you no longer need them.

---

## How the tests work

### Scripted UI (`tests/leo-video.spec.ts`)

1. Signs in, opens **Avatar Video Creator**, checks the four reel options, picks
   **Reel about a local story** and types a fixed input.
2. Clicks **Send** and finds the new task.
3. Every 20 seconds, reloads the task and reads its status. Questions (`WAITING_ON_INPUT`) get the
   scripted reply; approval cards (`WAITING_ON_HUMAN`) get **Approve** or **Complete Task**.
4. On `COMPLETED`, verifies the video (see [Verification](#verification)).

The same card is never answered twice, so a status that lags behind a click can't trigger a second
paid render.

### API (`tests/leo-video.api.spec.ts`)

Same scenario over HTTP: posts the message, polls `/api/v1/tasks/:id/detail`, answers questions via
`/clarify` and approvals via `/approve`, then verifies the video. What Leo is waiting for is worked
out by `pendingActions` in `tests/leoApi.ts`, which mirrors the app's own logic. Approvals are keyed
by `tool_call_id`, so each is sent once.

### AI-driven (`tests/leo-scenario.spec.ts`)

Runs one scenario file with Claude as the tester:

1. **Research** (scenarios with `research`): Claude searches the web for a real, current local story
   in a US city, with a source URL for each fact. Every source must load, or the run stops before
   anything is sent to Leo.
2. **Input:** Claude writes the message from the scenario brief and the sourced facts.
3. **Conversation:** for every question or approval card, Claude chooses to reply, click an allowed
   button, or stop, with the run so far as context. Each card appears as its own step in the report.
4. **Verification** as below, then Claude reviews the finished task against the scenario's success
   criteria.

Limits enforced in code: Claude may only click buttons listed in the scenario and visible on screen,
never answers the same card twice, answers at most four cards, and only the scenario named in
`LEO_SCENARIO` runs.

`tests/leoClaude.spec.ts` tests Claude's behaviour on its own, without Leo, using recorded Leo
questions in `tests/fixtures/`. Run it after changing a scenario brief or `tests/leoClaude.ts`.

### Verification

Every full run must show:

- the task reached `COMPLETED`
- the expected file (e.g. `mp4`) is listed in the task's artifacts (produced files are attached to
  the subtask, not the parent task)
- the file is served by S3 from the task's folder, was uploaded during this run, has the expected
  content type and, for video, a valid MP4 signature
- for video, the task page's player plays that same file

---

## Scenarios

Scenarios are JSON files in `scenarios/`, used by the AI-driven runner (and, for the fixed input and
reply, by the scripted and API tests).

| Field | Required | Meaning |
|---|---|---|
| `name` | Yes | Display name |
| `agent` | Yes | Office agent to open, e.g. `"Avatar Video Creator"` |
| `option` | No | Starter option to pick, e.g. `"Reel about a local story"` |
| `brief` | Yes | Everything Claude may say, claim or approve |
| `research` | No | `{}` researches a random city; `{"localStoryIn": "Boise, Idaho"}` pins one |
| `input` | No | Fixed first message; otherwise Claude writes one |
| `reply` | No | Fixed reply used by the scripted and API tests |
| `allowedButtons` | No | Buttons Claude may press. Default: `Approve`, `Complete Task` |
| `expect.artifactFormat` | No | File type to verify, e.g. `mp4`, `pdf`, `png` |
| `expect.successCriteria` | Yes | What Claude's final review must confirm |

To test another Leo agent, copy a scenario file and change `agent`, `option`, `brief`,
`allowedButtons` and `expect`. Then run it with `LEO_SCENARIO=<file name without .json>`.

---

## Project structure

```
scenarios/             Scenario files
tests/
  auth.setup.ts        Browser sign-in with 2FA; saves the session
  leo-video.spec.ts    Scripted UI tests
  leo-video.api.spec.ts  API tests
  leo-scenario.spec.ts AI-driven scenario runner
  leoClaude.spec.ts    Claude behaviour tests
  leoApi.spec.ts       Unit tests for pendingActions
  totp.spec.ts         Unit tests for the TOTP generator
  leoUi.ts             Shared browser flow
  leoApi.ts            API sign-in and pending-approval logic
  leoClaude.ts         Research, prompt writing, card decisions and final review
  s3Artifact.ts        Storage verification
  scenario.ts          Scenario loading and validation
  leoScenario.ts       Shared constants and the default scenario
  totp.ts              TOTP code generator
  fixtures/            Recorded Leo questions
paid.mjs               Runner for the paid scripts (confirmation prompt)
record.mjs             Manual session recorder
redact.mjs             Removes credentials from recorded logs
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "Bad credentials" at sign-in | Password cut short by a `#` in `.env` | Wrap `LEO_PASSWORD` in single quotes |
| Sign-in stops at the 2FA screen | Wrong or outdated `LEO_TOTP_SECRET`, or the machine's clock is off | Re-enroll 2FA; sync the system clock |
| API sign-in returns 403 | The load balancer blocks non-browser user agents | Keep the Chrome user agent in `tests/leoApi.ts` |
| A run ends with `WAITING_ON_FUNDS` | The account has no Leo billing balance | Top up the account; the test fails fast on this status |
| Claude stops with a reason | Leo asked something the brief doesn't cover, or the card didn't match | Read the reason in the report and extend the brief |
| `test-results/` evidence disappeared | Playwright clears it on every run | Paid runs write to `runs/` instead |
| Browser takes minutes to close after a run | Known with installed Chrome on some machines | Harmless; the run has already reported |
