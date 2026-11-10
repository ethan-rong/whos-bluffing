// Shared helpers for the API: responses, error wrapper, random codes, request validation.
import { ANON_RE } from './_daily.js';

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });

export const fail = (status, error) => json({ error }, status);

// Public reads (GET /api/round/stats, GET /api/kpi) may be fetched from any site: aggregates only, no ids.
export const CORS = { 'access-control-allow-origin': '*' };

// Does the request header equal the configured secret? Constant time (SHA-256 digests); no secret = nobody.
export async function headerMatches(request, header, secret) {
  const given = request.headers.get(header);
  if (!secret || !given) return false;
  const digest = async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([digest(given), digest(secret)]);
  return a.reduce((diff, x, i) => diff | (x ^ b[i]), 0) === 0;
}

// The Slack and Discord workers send x-bluff-bot: BOT_KEY (docs/api-rounds.md).
export const isBot = (request, env) => headerMatches(request, 'x-bluff-bot', env.BOT_KEY);

// Unexpected exceptions become a generic 500; details go to the log, never to the client.
export const safe = (handler) => async (ctx) => {
  try {
    return await handler(ctx);
  } catch (err) {
    console.error(err);
    return fail(500, 'server error');
  }
};

const MAX_BODY = 16384;

// Parses a JSON body with a size cap. Returns {body} or {error: Response}.
export async function readJson(request, { optional = false } = {}) {
  const text = await request.text();
  if (text.length > MAX_BODY) return { error: fail(413, 'request too large') };
  if (optional && !text.trim()) return { body: {} };
  try {
    return { body: JSON.parse(text) };
  } catch {
    return { error: fail(400, 'invalid JSON') };
  }
}

export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const SECRET_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
export const CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
export const SECRET_RE = /^[A-Za-z0-9_-]{24}$/;

// Both alphabets divide 256 evenly, so `byte % length` has no bias.
export const randomString = (n, alphabet) =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => alphabet[b % alphabet.length]).join('');

// Allowed demographic answers. Labels live in public/i18n/*.json under demo.options (keys must match; npm test checks).
export const DEMOGRAPHICS = {
  age: ['u18', '18_24', '25_34', '35_44', '45_54', '55_64', '65p'],
  edu: ['secondary', 'vocational', 'bachelor', 'graduate'],
  native: ['en', 'zh', 'both', 'other'],
  region: ['cn_mainland', 'hk_mo_tw', 'east_asia_other', 'southeast_asia', 'south_asia', 'mena',
    'subsaharan_africa', 'europe', 'north_america', 'latin_america', 'oceania', 'other'],
};

export const EXPECTED = { '2afc': 12, interval: 6, attention: 2 };
const CONF_UI = [50, 60, 70, 80, 90, 100];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

function demographicsError(d) {
  if (d == null) return null;
  if (!isObject(d)) return 'demographics must be an object';
  for (const [k, v] of Object.entries(d)) {
    if (!DEMOGRAPHICS[k]) return `unknown demographic field ${String(k).slice(0, 20)}`;
    if (!DEMOGRAPHICS[k].includes(v)) return `bad value for ${k}`;
  }
  return null;
}

function answerError(a, it) {
  if (!(Number.isFinite(a.rt_ms) && a.rt_ms >= 0)) return `bad rt_ms for ${a.id}`;
  if (it.type === 'interval') {
    if (!Number.isFinite(a.low) || !Number.isFinite(a.high) || a.low > a.high) return `bad range for ${a.id}`;
    return null;
  }
  if (a.choice !== 0 && a.choice !== 1) return `bad choice for ${a.id}`;
  if (!CONF_UI.includes(a.conf)) return `bad conf for ${a.id}`;
  return null;
}

// Validates a POST /api/submit body against the item bank (Map id -> item). Returns an error string or null.
// Out-of-bounds ranges and fast answers are NOT rejected here: they are analysis-time exclusions.
export function validateSubmit(body, items) {
  if (!isObject(body)) return 'body must be a JSON object';
  if (body.lang !== 'en') return 'lang must be en';
  if (body.class_code != null && !CODE_RE.test(body.class_code)) return 'bad class_code';
  if (body.first_session_id != null && !UUID_RE.test(body.first_session_id)) return 'bad first_session_id';
  if (body.anon_id != null && !(typeof body.anon_id === 'string' && ANON_RE.test(body.anon_id))) return 'bad anon_id';
  const demoErr = demographicsError(body.demographics);
  if (demoErr) return demoErr;
  if (!Array.isArray(body.answers)) return 'answers must be an array';
  const seen = new Set();
  const counts = { '2afc': 0, interval: 0, attention: 0 };
  for (const a of body.answers) {
    const it = isObject(a) && typeof a.id === 'string' ? items.get(a.id) : undefined;
    if (!it) return `unknown item ${String(a?.id).slice(0, 20)}`;
    if (seen.has(a.id)) return `duplicate item ${a.id}`;
    seen.add(a.id);
    counts[it.type] += 1;
    const err = answerError(a, it);
    if (err) return err;
  }
  for (const [type, n] of Object.entries(EXPECTED)) {
    if (counts[type] !== n) return `expected ${n} ${type} answers, got ${counts[type]}`;
  }
  return null;
}
