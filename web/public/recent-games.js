// Completed results stay on this browser only. Restoring them never completes a round again.
import { store } from './ui.js';
import { PACKS, DIFFICULTY_LABELS } from './packs.js';
import { TYPE_NAMES } from './types.js';

const KEY = 'whosbluffing_recent_games';
const LIMIT = 10;
const text = (v) => typeof v === 'string';
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const number = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;
const date = (v) => text(v) && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
const source = (v) => {
  try { return text(v) && /^https?:\/\//.test(v) && ['http:', 'https:'].includes(new URL(v).protocol); } catch { return false; }
};

function challengePath(value, round) {
  if (!text(value) || !/^(?:\/(?!\/)|https?:\/\/)/.test(value)) return null;
  try {
    const url = new URL(value, 'https://whosbluffing.com');
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (!(local || (url.origin === 'https://whosbluffing.com')) || url.username || url.password || url.search || url.hash) return null;
    return new RegExp(`^/c/${round.round_id}/[A-Za-z0-9_-]{10}$`).test(url.pathname) ? url.pathname : null;
  } catch { return null; }
}

function validEntry(entry) {
  if (!object(entry)) return null;
  const { round, result, completedAt } = entry;
  if (!object(round) || !object(result) || !text(completedAt) || !Number.isFinite(Date.parse(completedAt))) return null;
  const ids = { quick: /^[A-Z2-9]{12}$/, ranked: /^rk-\d{4}-\d{2}-\d{2}$/ };
  if (!text(round.mode) || !Object.hasOwn(ids, round.mode) || !text(round.round_id) || !ids[round.mode].test(round.round_id) || !date(round.date)) return null;
  if (round.mode === 'ranked' && round.round_id !== `rk-${round.date}`) return null;
  if (round.mode === 'quick' && (round.pack == null || round.difficulty == null)) return null;
  if ((round.pack != null && (!text(round.pack) || !Object.hasOwn(PACKS, round.pack)))
    || (round.difficulty != null && (!text(round.difficulty) || !Object.hasOwn(DIFFICULTY_LABELS, round.difficulty)))) return null;
  if (round.challenge != null && (!text(round.challenge) || !/^[A-Za-z0-9_-]{10}$/.test(round.challenge))) return null;
  if (!Array.isArray(round.items) || round.items.length !== 10 || !object(round.answers) || !Number.isFinite(round.total)) return null;
  const unique = new Set();
  for (const item of round.items) {
    if (!object(item) || !text(item.id) || !item.id || unique.has(item.id) || ![item.prompt, item.a, item.b].every(text)) return null;
    unique.add(item.id);
    const answer = round.answers[item.id];
    if (!object(answer) || ![0, 1].includes(answer.choice) || ![50, 60, 70, 80, 90, 100].includes(answer.conf)
      || typeof answer.correct !== 'boolean' || !number(answer.points, -300, 100) || !object(answer.truth)) return null;
    const truth = answer.truth;
    if (![truth.a_value, truth.b_value].every((v) => text(v) || Number.isFinite(v)) || !text(truth.unit)
      || ![truth.a_source, truth.b_source].every(source)) return null;
    if ([answer.line, answer.template, truth.fun].some((v) => v != null && !text(v))) return null;
  }
  if (!number(result.score, -3000, 1000) || !number(result.accuracy, 0, 100) || !number(result.mean_conf, 50, 100)
    || !Number.isInteger(result.streak) || result.streak < 0 || !text(result.type) || !Object.hasOwn(TYPE_NAMES, result.type) || !text(result.share_text)
    || (result.roast != null && !text(result.roast))) return null;
  const path = challengePath(result.challenge_url, round);
  return path ? { round, result: { ...result, challenge_url: path }, completedAt: new Date(completedAt).toISOString() } : null;
}

export function recentGames() {
  const saved = store.get(KEY, []);
  if (!Array.isArray(saved)) return [];
  const seen = new Set();
  return saved.map(validEntry).filter((entry) => {
    if (!entry || seen.has(entry.round.round_id)) return false;
    seen.add(entry.round.round_id);
    return true;
  }).sort((a, b) => b.completedAt.localeCompare(a.completedAt)).slice(0, LIMIT);
}

export const recentGame = (roundId) => recentGames().find((entry) => entry.round.round_id === roundId) ?? null;

export function rememberGame(round, result, completedAt = new Date().toISOString()) {
  const entry = validEntry({ round, result, completedAt });
  if (!entry) return false;
  const saved = recentGames();
  if (saved.some((previous) => previous.round.round_id === round.round_id)) return true;
  store.set(KEY, [entry, ...saved].sort((a, b) => b.completedAt.localeCompare(a.completedAt)).slice(0, LIMIT));
  return recentGame(round.round_id) !== null; // store.set intentionally swallows blocked/quota errors.
}
