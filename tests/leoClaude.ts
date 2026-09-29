import { spawn } from 'node:child_process';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { expect, type APIRequestContext } from '@playwright/test';
import { z } from 'zod';
import type { Answerer, LeoAnswer, LeoCard, LeoRun } from './leoUi';

const MODEL = 'claude-opus-5-5';
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';
const MAX_SEARCH_TURNS = 5;

const ROLE = `You are a QA tester driving Leo, Real Brokerage's AI assistant, through the scenario below.
Only state facts the scenario gives you. If Leo needs something the scenario does not cover, stop instead of inventing it.
Approve spends money: press it only when the plan shown on the card matches the scenario. Leo's earlier steps vary
from run to run, so judge each approval card by what it shows, not by which steps came before it.
Complete Task accepts finished work.`;

const LocalStorySchema = z.object({
  headline: z.string(),
  city: z.string(),
  facts: z.array(z.object({ text: z.string(), sourceUrl: z.string() })),
});
export type LocalStory = z.infer<typeof LocalStorySchema>;

let client: Anthropic | undefined;
const claude = () => (client ??= new Anthropic());

// Without an API key, fall back to headless Claude Code, which runs on the developer's own Claude login
export const USES_CLAUDE_CODE = !process.env.ANTHROPIC_API_KEY;
const CLAUDE_BIN =
  process.env.CLAUDE_BIN ?? `${process.env.APPDATA}/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe`;
const CLAUDE_CODE_TIMEOUT = 10 * 60_000;

async function askClaudeCode<T extends z.ZodType>(schema: T, system: string, content: string, tools = ''): Promise<z.infer<T>> {
  // The CLI's validator rejects zod's draft 2020-12 "$schema" tag; the schema body itself is compatible
  const { $schema, ...jsonSchema } = z.toJSONSchema(schema);
  const args = ['-p', '--output-format', 'json', '--json-schema', JSON.stringify(jsonSchema)];
  args.push('--model', MODEL, '--system-prompt', system, '--tools', tools, '--no-session-persistence');
  // --tools only makes a tool available; headless mode still denies it unless it is also pre-approved
  if (tools) args.push('--allowedTools', tools);
  const child = spawn(CLAUDE_BIN, args, { stdio: ['pipe', 'pipe', 'pipe'], timeout: CLAUDE_CODE_TIMEOUT });
  child.stdin.end(content);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const code = await new Promise((resolve) => child.on('close', resolve));

  const result = JSON.parse(stdout || '{}');
  if (code !== 0 || result.is_error || !result.structured_output) {
    throw new Error(`Claude Code failed (exit ${code}, ${result.subtype ?? 'no result'}): ${stderr.slice(0, 500)}`);
  }
  return schema.parse(result.structured_output);
}

async function ask<T extends z.ZodType>(schema: T, system: string, content: string): Promise<z.infer<T>> {
  if (USES_CLAUDE_CODE) return askClaudeCode(schema, system, content);
  const response = await claude().messages.parse({
    model: MODEL,
    max_tokens: 16000,
    system,
    messages: [{ role: 'user', content }],
    output_config: { format: zodOutputFormat(schema) },
  });
  if (response.stop_reason === 'refusal') throw new Error(`Claude declined: ${response.stop_details?.explanation ?? ''}`);
  if (!response.parsed_output) throw new Error(`Claude returned no parsable output (stop_reason ${response.stop_reason})`);
  return response.parsed_output;
}

// Mid-size US cities with active local news; a random pick keeps each run on a different real story
const STORY_AREAS = [
  'Boise, Idaho', 'Asheville, North Carolina', 'Chattanooga, Tennessee', 'Spokane, Washington', 'Tulsa, Oklahoma',
  'Greenville, South Carolina', 'Madison, Wisconsin', 'Albuquerque, New Mexico', 'Des Moines, Iowa', 'Knoxville, Tennessee',
  'Savannah, Georgia', 'Fort Collins, Colorado', 'Lexington, Kentucky', 'Reno, Nevada', 'Sioux Falls, South Dakota',
  'Grand Rapids, Michigan', 'Boulder, Colorado', 'Bend, Oregon', 'Omaha, Nebraska', 'Cheyenne, Wyoming',
];

export function pickStoryArea(configured?: string) {
  return process.env.LEO_STORY_AREA ?? configured ?? STORY_AREAS[Math.floor(Math.random() * STORY_AREAS.length)];
}

const storySearch = (area: string) => `Search the web for one real local story that people in ${area} are talking
about right now and that a real estate agent could make a friendly 20-second reel about: a community event, festival,
opening, local milestone or tradition. Avoid politics, crime, accidents and anything sad or divisive. Prefer events
happening in the next 30 days or news from the last 14 days. Report only facts a reputable source states, and give the
source URL for each fact. Include the exact dates, times and place names the sources give.`;

// API path takes two calls: web search results carry citations, which structured output rejects
export async function findLocalStory(area: string): Promise<LocalStory> {
  if (USES_CLAUDE_CODE) {
    return askClaudeCode(
      LocalStorySchema,
      'You are a careful local news researcher. Every fact you return must come from a page you actually opened.',
      `${storySearch(area)}\nReturn the headline, the city and state, and each distinct fact with its source URL.`,
      'WebSearch,WebFetch',
    );
  }
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: storySearch(area) }];
  let response: Anthropic.Message | undefined;
  for (let turn = 0; turn < MAX_SEARCH_TURNS; turn++) {
    response = await claude().messages.create({
      model: MODEL,
      max_tokens: 16000,
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 8 }],
      messages,
    });
    if (response.stop_reason !== 'pause_turn') break;
    // The server's search loop paused; send its partial turn back unchanged to resume it
    messages.push({ role: 'assistant', content: response.content });
  }
  if (response?.stop_reason === 'refusal') throw new Error('Claude declined the local story search');
  const research = response!.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');

  return ask(
    LocalStorySchema,
    'You extract facts from research notes without adding anything.',
    `From these research notes, return the story's headline, the city and state, and each distinct fact with the
source URL that supports it. Leave out anything the notes do not attribute to a source.
---
${research}`,
  );
}

// A made-up citation 404s or fails DNS; 401/403/429 means the page exists but blocks bots
export async function expectRealSources(request: APIRequestContext, story: LocalStory) {
  expect(story.facts.length, 'The story has at least two sourced facts').toBeGreaterThanOrEqual(2);
  for (const url of new Set(story.facts.map((fact) => fact.sourceUrl))) {
    const response = await request.get(url, { headers: { 'User-Agent': BROWSER_UA }, maxRedirects: 5 });
    expect(response.status() < 400 || [401, 403, 429].includes(response.status()), `Source loads: ${url}`).toBe(true);
  }
}

export function briefWithStory(brief: string, story: LocalStory) {
  const facts = story.facts.map((fact) => `- ${fact.text} (source: ${fact.sourceUrl})`).join('\n');
  return `${brief}\n\nThe reel is about this real local story in ${story.city}: ${story.headline}.
The only facts you may use (each checked against its source):\n${facts}`;
}

export async function writeLeoPrompt(brief: string, prefill: string) {
  return ask(
    z.object({ message: z.string(), script: z.string() }),
    `${ROLE}\n\nScenario:\n${brief}`,
    `Write the single message to send to Leo so it can finish the scenario without asking follow-up questions.
${prefill ? `Start the message with exactly: "${prefill}".` : ''}
Name the city, give the facts with their sources, include a complete script (under 60 words) that uses only those
facts, say the script is approved as-is, and name the style and voice if the scenario gives them.
Also return that script on its own in "script", word for word as it appears in the message.`,
  );
}

export type CardHistory = { card: string; answer: LeoAnswer }[];

export async function decideForCard(brief: string, card: LeoCard, history: CardHistory = []): Promise<LeoAnswer> {
  const earlier = history.length
    ? `Earlier in this run you handled these cards, in order:\n${history
        .map(({ card: text, answer }, i) => `${i + 1}. "${text.slice(0, 400)}" -> you chose ${JSON.stringify(answer)}`)
        .join('\n')}\n\n`
    : 'This is the first card Leo has shown in this run.\n\n';
  const decision = await ask(
    z.object({ action: z.enum(['reply', 'click', 'stop']), button: z.string(), reply: z.string(), reason: z.string() }),
    `${ROLE}\n\nScenario:\n${brief}`,
    `${earlier}Leo's task is ${card.status} and now shows this card:
---
${card.text}
---
Buttons you may press: ${card.buttons.length ? card.buttons.join(', ') : 'none (only a reply box)'}.

Choose one action:
- "reply": answer in the reply box, text in "reply". Only when there are no buttons.
- "click": press one of the buttons listed above, its exact name in "button".
- "stop": the card is about something else, needs facts the scenario does not give, or anything looks wrong.
Leave unused fields empty. Give a one-sentence "reason".`,
  );

  // Claude's choice must match what is actually on screen; anything else stops before a paid click
  if (decision.action === 'click' && card.buttons.includes(decision.button)) {
    return { action: 'click', button: decision.button };
  }
  if (decision.action === 'reply' && !card.buttons.length && decision.reply.trim()) {
    return { action: 'reply', text: decision.reply };
  }
  return { action: 'stop', reason: `${decision.action}: ${decision.reason}` };
}

// Each decision sees the run so far; judged in isolation, "Complete Task" looks like it skipped the approvals
export function answerWithClaude(brief: string): Answerer {
  const history: CardHistory = [];
  return async (card) => {
    const answer = await decideForCard(brief, card, history);
    history.push({ card: card.text, answer });
    return answer;
  };
}

export async function judgeRun(brief: string, successCriteria: string, run: LeoRun) {
  return ask(
    z.object({ pass: z.boolean(), reason: z.string() }),
    'You are a strict QA reviewer. Judge only from the evidence given; if the evidence is missing, fail.',
    `Scenario:\n${brief}\n\nSuccess criteria: ${successCriteria}

Evidence from the finished Leo task:
- Title: ${run.detail?.title ?? ''}
- Result summary: ${run.detail?.result_summary ?? ''}
- Cards Leo showed, in order:\n${run.cards.map((card, i) => `  ${i + 1}. ${card}`).join('\n')}
- Files produced: ${run.artifacts.map((artifact) => `${artifact.filename} (${artifact.format})`).join(', ') || 'none'}

Does the evidence show the success criteria were met? Give a one-sentence reason.`,
  );
}
