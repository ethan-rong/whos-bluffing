-- Who's Bluffing for Anki v0.2: opt-in anonymous rating uploads (POST /api/anki/submit, /api/anki/delete, GET /api/anki/stats).
-- Request paths touch only the request's own rows, the install's anki_installs row and two anki_agg rows; nothing on a
-- request path scans anki_rows.

-- One row per installation id (the add-on's local salt hashed again; the salt never leaves the computer).
-- rows = ratings currently stored for the install. A deleted install keeps only its id and deleted_at, so a later
-- upload from it gets 410.
CREATE TABLE anki_installs (
  install_id TEXT PRIMARY KEY,
  first_seen TEXT,
  last_seen TEXT,
  rows INTEGER NOT NULL DEFAULT 0,
  consent_version TEXT,
  deleted_at TEXT
);

-- One row per uploaded rating, idempotent on (install_id, row_id). row_id is the add-on's local sequence number.
-- WITHOUT ROWID: the primary key is the table, so each insert or delete writes one row instead of two.
CREATE TABLE anki_rows (
  install_id TEXT NOT NULL,
  row_id INTEGER NOT NULL,
  ts TEXT,
  card_hash TEXT,
  deck_hash TEXT,
  notetype_hash TEXT,
  jol INTEGER NOT NULL,
  ease INTEGER NOT NULL,
  q_rt_ms INTEGER,
  a_rt_ms INTEGER,
  ivl_days REAL,
  reps INTEGER,
  lapses INTEGER,
  days_since_last_review REAL,
  stability REAL,
  difficulty REAL,
  retrievability REAL,
  anki_version TEXT,
  addon_version TEXT,
  PRIMARY KEY (install_id, row_id)
) WITHOUT ROWID;

-- Each live install, with all its rows, is counted on the UTC day of its latest upload: a submit moves it from its
-- previous day to today, a delete takes it off its day. So installs active in the trailing 30 days = SUM(installs) over
-- those days, and rows_total = SUM(rows), both exact without reading anki_installs or anki_rows.
CREATE TABLE anki_agg (
  day TEXT PRIMARY KEY,
  installs INTEGER NOT NULL,
  rows INTEGER NOT NULL
);

-- Anki contributors are reported next to MAU, never inside it (MAU counts plays). Written by the KPI job.
ALTER TABLE kpi ADD COLUMN anki_contributors_30d INTEGER NOT NULL DEFAULT 0;
