-- Adds Phase 7-oriented browser lifecycle and device hint evidence.

alter table public.beta_evidence
  add column if not exists lifecycle_signals jsonb not null default '[]'::jsonb,
  add column if not exists device_hints jsonb;
