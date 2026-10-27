CREATE TYPE image_kind AS ENUM ('original', 'stego', 'variant');
CREATE TYPE operation_type AS ENUM ('encode', 'decode', 'experiment');
CREATE TYPE stego_method AS ENUM ('lsb', 'dct-koch-zhao', 'dwt-qim');
CREATE TYPE job_status AS ENUM ('queued', 'running', 'succeeded', 'failed');

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE refresh_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);

CREATE TABLE images (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind        image_kind NOT NULL,
  -- Object key in R2 / MinIO, e.g. users/{userId}/{uuid}.png
  storage_key text NOT NULL UNIQUE,
  format      text NOT NULL,
  width       integer NOT NULL,
  height      integer NOT NULL,
  size_bytes  integer NOT NULL,
  sha256      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX images_user_idx ON images (user_id, created_at);

-- User-facing history entry. Never stores the hidden message itself.
CREATE TABLE operations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type            operation_type NOT NULL,
  method          stego_method,
  source_image_id uuid REFERENCES images (id) ON DELETE SET NULL,
  result_image_id uuid REFERENCES images (id) ON DELETE SET NULL,
  status          job_status NOT NULL DEFAULT 'queued',
  params          jsonb NOT NULL DEFAULT '{}',
  result          jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX operations_user_idx ON operations (user_id, created_at);

-- Work queue consumed by the worker with SELECT … FOR UPDATE SKIP LOCKED.
CREATE TABLE jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL REFERENCES operations (id) ON DELETE CASCADE,
  status       job_status NOT NULL DEFAULT 'queued',
  attempts     integer NOT NULL DEFAULT 0,
  error        text,
  run_after    timestamptz NOT NULL DEFAULT now(),
  locked_at    timestamptz,
  finished_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_pick_idx ON jobs (status, run_after);
