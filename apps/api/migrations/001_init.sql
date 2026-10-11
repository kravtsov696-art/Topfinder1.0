-- «Близкие» P0 — начальная схема.
-- PostGIS используется, если доступен (docker-compose / Render). Без него схема работает,
-- просто не создаётся колонка geog (P0 не делает пространственных запросов на сервере).

DO $$
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS postgis;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'PostGIS недоступен: %', SQLERRM;
  END;
END $$;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS devices (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash bytea UNIQUE,
  platform text NOT NULL CHECK (platform IN ('ios', 'android', 'test')),
  model text,
  os_version text,
  app_version text,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  sharing_mode text NOT NULL DEFAULT 'OFF' CHECK (sharing_mode IN ('OFF', 'ECO', 'ACTIVE_TRIP')),
  mode_changed_at timestamptz NOT NULL DEFAULT now(),
  active_trip_until timestamptz,
  push_token text,
  push_token_kind text,
  push_token_updated_at timestamptz,
  status_report jsonb,
  status_reported_at timestamptz,
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS invites (
  id uuid PRIMARY KEY,
  code_hash bytea NOT NULL UNIQUE,
  inviter_device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  consumed_by_device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  cancelled_at timestamptz
);

CREATE TABLE IF NOT EXISTS pairs (
  id uuid PRIMARY KEY,
  initiator_device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  acceptor_device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  invite_id uuid REFERENCES invites(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by_device_id uuid,
  CHECK (initiator_device_id <> acceptor_device_id)
);
CREATE INDEX IF NOT EXISTS pairs_initiator_idx ON pairs (initiator_device_id);
CREATE INDEX IF NOT EXISTS pairs_acceptor_idx ON pairs (acceptor_device_id);

-- Направленное разрешение: owner показывает свою точку viewer. По умолчанию выключено.
CREATE TABLE IF NOT EXISTS pair_grants (
  pair_id uuid NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
  owner_device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  viewer_device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  enabled_since timestamptz,
  changed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pair_id, owner_device_id)
);

CREATE TABLE IF NOT EXISTS location_fixes (
  id bigserial PRIMARY KEY,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  client_fix_id uuid NOT NULL,
  measured_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  device_sent_at timestamptz,
  clock_skew_ms integer,
  lat double precision NOT NULL,
  lon double precision NOT NULL,
  accuracy_m double precision NOT NULL,
  altitude double precision,
  altitude_accuracy_m double precision,
  speed_mps double precision,
  heading_deg double precision,
  is_mocked boolean,
  reduced_accuracy boolean,
  source text NOT NULL,
  app_state text,
  network_type text,
  battery_level double precision,
  sharing_mode text,
  scenario text,
  enqueued_at timestamptz,
  attempt integer,
  quality text NOT NULL CHECK (quality IN ('accepted', 'low_quality', 'suspect')),
  late boolean NOT NULL DEFAULT false,
  refresh_request_id uuid,
  UNIQUE (device_id, client_fix_id)
);
CREATE INDEX IF NOT EXISTS location_fixes_latest_idx ON location_fixes (device_id, measured_at DESC);
CREATE INDEX IF NOT EXISTS location_fixes_received_idx ON location_fixes (received_at);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis') THEN
    EXECUTE 'ALTER TABLE location_fixes ADD COLUMN IF NOT EXISTS geog geography(Point, 4326)';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS refresh_requests (
  id uuid PRIMARY KEY,
  client_request_id text NOT NULL,
  pair_id uuid NOT NULL REFERENCES pairs(id) ON DELETE CASCADE,
  requester_device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  target_device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  deadline_at timestamptz NOT NULL,
  state text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  failure_reason text,
  push_ticket text,
  fix_id bigint REFERENCES location_fixes(id) ON DELETE SET NULL,
  fix_measured_at timestamptz,
  fix_received_at timestamptz,
  UNIQUE (requester_device_id, client_request_id)
);
CREATE INDEX IF NOT EXISTS refresh_requests_target_idx ON refresh_requests (target_device_id, state);

CREATE TABLE IF NOT EXISTS refresh_request_events (
  id bigserial PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES refresh_requests(id) ON DELETE CASCADE,
  state text NOT NULL,
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  detail jsonb
);
CREATE INDEX IF NOT EXISTS refresh_request_events_req_idx ON refresh_request_events (request_id, at);

CREATE TABLE IF NOT EXISTS diagnostic_events (
  id bigserial PRIMARY KEY,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  client_event_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  type text NOT NULL,
  data jsonb,
  UNIQUE (device_id, client_event_id)
);
CREATE INDEX IF NOT EXISTS diagnostic_events_dev_idx ON diagnostic_events (device_id, occurred_at DESC);
