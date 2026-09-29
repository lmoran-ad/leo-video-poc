import { loadScenario } from './scenario';

export const CHEYENNE = loadScenario('cheyenne-frontier-days');
export const LOCAL_STORY_PREFILL = 'Make a reel of me on a story people in my area are talking about';
export const INPUT = CHEYENNE.input!;
export const REPLY = CHEYENNE.reply!;

// A researched AI run took three rounds on its script (review, fix a claim, lengthen) before approving
export const MAX_QUESTIONS = 5;
export const GENERATION_TIMEOUT = 25 * 60_000;
export const SUCCESS = ['COMPLETED', 'SUCCEEDED'];
export const FAILURE = ['FAILED', 'TIMED_OUT', 'CANCELLED', 'WAITING_ON_FUNDS'];
