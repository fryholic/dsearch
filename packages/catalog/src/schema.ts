export const STATE_SCHEMA = String.raw`
-- schema: state-v2
PRAGMA foreign_keys = ON;

CREATE TABLE collections (
  collection_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  root_path TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  scope_fp TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  created_at TEXT NOT NULL
);

CREATE TABLE source_documents (
  doc_id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL REFERENCES collections(collection_id),
  relative_path TEXT NOT NULL,
  file_key TEXT,
  present INTEGER NOT NULL CHECK (present IN (0,1)),
  eligibility TEXT NOT NULL,
  latest_revision_id TEXT,
  eligibility_reason TEXT,
  observed_seq INTEGER NOT NULL,
  observed_at TEXT NOT NULL
);
CREATE UNIQUE INDEX current_document_path
  ON source_documents(collection_id, relative_path) WHERE present=1;

CREATE TABLE source_revisions (
  revision_id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES source_documents(doc_id),
  raw_sha256 TEXT NOT NULL CHECK (length(raw_sha256)=64),
  text_sha256 TEXT NOT NULL CHECK (length(text_sha256)=64),
  byte_size INTEGER NOT NULL CHECK (byte_size>=0),
  metadata_json TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  UNIQUE(doc_id, raw_sha256),
  UNIQUE(doc_id, revision_id)
);

CREATE TABLE profiles (
  profile_id TEXT PRIMARY KEY,
  profile_fp TEXT NOT NULL UNIQUE,
  manifest_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','validated','retired')),
  created_at TEXT NOT NULL
);

CREATE TABLE generations (
  generation_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(profile_id),
  profile_fp TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('building','validating','ready','active','retired','invalid')
  ),
  directory_path TEXT NOT NULL UNIQUE,
  source_seq INTEGER NOT NULL,
  manifest_sha256 TEXT,
  coverage_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sealed_at TEXT
);

CREATE TABLE generation_documents (
  generation_id TEXT NOT NULL REFERENCES generations(generation_id),
  doc_id TEXT NOT NULL REFERENCES source_documents(doc_id),
  revision_id TEXT NOT NULL,
  processing_state TEXT NOT NULL CHECK (
    processing_state IN ('included','partial','lexical_only','excluded','pending','failed')
  ),
  reason TEXT,
  PRIMARY KEY(generation_id, doc_id),
  UNIQUE(generation_id, doc_id, revision_id),
  FOREIGN KEY(doc_id, revision_id)
    REFERENCES source_revisions(doc_id, revision_id)
);

CREATE TABLE passages (
  generation_id TEXT NOT NULL,
  passage_id TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  engine_collection TEXT NOT NULL,
  engine_relative_path TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('semantic','lexical_only')),
  projection_sha256 TEXT NOT NULL CHECK (length(projection_sha256)=64),
  source_map_json TEXT NOT NULL,
  heading_json TEXT NOT NULL,
  embedding_tokens INTEGER,
  processing_state TEXT NOT NULL,
  PRIMARY KEY(generation_id, passage_id),
  UNIQUE(generation_id, engine_collection, engine_relative_path),
  FOREIGN KEY(generation_id, doc_id, revision_id)
    REFERENCES generation_documents(generation_id, doc_id, revision_id),
  FOREIGN KEY(doc_id, revision_id)
    REFERENCES source_revisions(doc_id, revision_id)
);

CREATE TABLE active_slot (
  slot INTEGER PRIMARY KEY CHECK (slot=1),
  generation_id TEXT NOT NULL REFERENCES generations(generation_id),
  epoch INTEGER NOT NULL CHECK (epoch>0),
  changed_at TEXT NOT NULL
);

CREATE TABLE jobs (
  job_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  generation_id TEXT REFERENCES generations(generation_id),
  state TEXT NOT NULL CHECK (
    state IN ('queued','running','retry_wait','succeeded','failed','cancelled','obsolete')
  ),
  phase TEXT NOT NULL,
  cursor_json TEXT NOT NULL,
  progress_json TEXT NOT NULL,
  cancel_requested INTEGER NOT NULL CHECK (cancel_requested IN (0,1)),
  attempt INTEGER NOT NULL CHECK (attempt>=0),
  lease_owner TEXT,
  lease_expires_at TEXT,
  error_code TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE decisions (
  decision_id TEXT PRIMARY KEY,
  source_doc_id TEXT NOT NULL REFERENCES source_documents(doc_id),
  target_doc_id TEXT NOT NULL REFERENCES source_documents(doc_id),
  source_revision_id TEXT NOT NULL,
  target_revision_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('keep','dismiss','revoke')),
  confirmed_payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE write_operations (
  operation_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  source_doc_id TEXT NOT NULL REFERENCES source_documents(doc_id),
  target_doc_id TEXT REFERENCES source_documents(doc_id),
  kind TEXT NOT NULL CHECK (kind IN ('apply','undo')),
  original_operation_id TEXT REFERENCES write_operations(operation_id),
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256)=64),
  expected_text_sha256 TEXT NOT NULL CHECK (length(expected_text_sha256)=64),
  after_text_sha256 TEXT CHECK (after_text_sha256 IS NULL OR length(after_text_sha256)=64),
  patch_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('prepared','buffer_applied','committed','not_applied',
              'review_required','conflict','reverted')
  ),
  updated_at TEXT NOT NULL
);

CREATE TABLE evaluation_runs (
  evaluation_id TEXT PRIMARY KEY,
  generation_id TEXT NOT NULL REFERENCES generations(generation_id),
  dataset_sha256 TEXT NOT NULL CHECK (length(dataset_sha256)=64),
  config_sha256 TEXT NOT NULL CHECK (length(config_sha256)=64),
  artifact_path TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE catalog_meta (slot INTEGER PRIMARY KEY CHECK(slot=1), source_seq INTEGER NOT NULL CHECK(source_seq>=0));
INSERT INTO catalog_meta VALUES (1,0);
PRAGMA user_version = 2;
`;
