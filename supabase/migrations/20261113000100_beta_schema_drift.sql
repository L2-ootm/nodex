-- Databases created before 20261002000200 keep their old beta tables (that migration uses
-- create table if not exists), so they lack columns the current server writes. Found on the
-- production project: evidence inserts failed with PGRST204 (lifecycle_signals) and presence upserts
-- need room_id plus the unique key behind onConflict 'token_hash,room_id'. Idempotent.
alter table public.beta_evidence add column if not exists lifecycle_signals jsonb not null default '[]';
alter table public.beta_evidence add column if not exists device_hints jsonb;
alter table public.beta_presence add column if not exists room_id text not null default '';
create unique index if not exists beta_presence_token_room on public.beta_presence(token_hash, room_id);
notify pgrst, 'reload schema';
