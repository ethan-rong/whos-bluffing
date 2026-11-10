-- Daily game (v4). Request paths read and write O(1) rows; only the daily KPI job (POST /api/kpi/run) scans
-- plays, players and sessions. Dates are UTC YYYY-MM-DD; times are ISO strings.

-- Anonymous ids of the daily game (web: random browser id; Slack: salted hash, never raw ids). A row is created at
-- the first completed play, or at the first answer that carries a community; plays counts completed plays only.
CREATE TABLE players (
  anon_id TEXT PRIMARY KEY,
  surface TEXT NOT NULL,          -- web | slack | classroom
  first_seen TEXT NOT NULL,       -- when the row was created
  last_seen TEXT NOT NULL,        -- time of the latest completed play (creation time until then)
  plays INTEGER NOT NULL,         -- completed plays
  community TEXT                  -- web: NULL; slack: team hash; classroom: class code
);

-- One row per completed play. streak = consecutive game days on this surface ending at this date
-- (the previous day's streak + 1, so completing reads one extra row, never the player's history).
CREATE TABLE plays (
  anon_id TEXT NOT NULL,
  date TEXT NOT NULL,             -- the game day
  surface TEXT NOT NULL,
  hits INTEGER NOT NULL,
  n INTEGER NOT NULL,             -- items scored: 5, fewer if an item was retired before completion
  completed_at TEXT NOT NULL,
  streak INTEGER NOT NULL,
  PRIMARY KEY (anon_id, date, surface)
);

-- One row per answered daily item; hit is computed by the server from the pool. The first answer is final.
CREATE TABLE daily_answers (
  anon_id TEXT NOT NULL,
  date TEXT NOT NULL,
  item_id TEXT NOT NULL,
  low REAL NOT NULL,
  high REAL NOT NULL,
  hit INTEGER NOT NULL,
  rt_ms INTEGER,
  answered_at TEXT NOT NULL,
  PRIMARY KEY (anon_id, date, item_id)
);

-- Completed plays per day and surface, maintained on complete. hits_hist = JSON [n0..n5] over the day's
-- non-retired items. patterns = JSON array of 32 counts indexed by hit bitmask (bit k = the day's k-th scheduled
-- item was hit), so retiring an item recomputes hits_hist from this row alone.
CREATE TABLE daily_agg (
  date TEXT NOT NULL,
  surface TEXT NOT NULL,
  players INTEGER NOT NULL,
  hits_hist TEXT NOT NULL,
  patterns TEXT NOT NULL,
  PRIMARY KEY (date, surface)
);

-- One flag per item and anonymous id; the third distinct flag retires the item.
CREATE TABLE item_flags (
  item_id TEXT NOT NULL,
  anon_id TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (item_id, anon_id)
);

-- Online difficulty, updated on each first answer. mean_log_err = running mean of |log10(midpoint / truth)| over
-- the n_log_err answers where it is defined (midpoint and truth both > 0).
CREATE TABLE items_runtime (
  item_id TEXT PRIMARY KEY,
  retired_at TEXT,
  n_answers INTEGER NOT NULL DEFAULT 0,
  n_hits INTEGER NOT NULL DEFAULT 0,
  mean_log_err REAL,
  n_log_err INTEGER NOT NULL DEFAULT 0
);

-- Written once a day by POST /api/kpi/run; GET /api/kpi and the stats page read only this table.
CREATE TABLE kpi (
  as_of TEXT PRIMARY KEY,
  mau INTEGER NOT NULL,
  dau INTEGER NOT NULL,
  mau_web INTEGER NOT NULL,
  mau_slack INTEGER NOT NULL,
  mau_classroom INTEGER NOT NULL,
  workspaces INTEGER NOT NULL,
  classrooms INTEGER NOT NULL,
  computed_at TEXT NOT NULL
);

-- Full assessments carry the same browser id as the daily game, so MAU counts a web player once.
ALTER TABLE sessions ADD COLUMN anon_id TEXT;
