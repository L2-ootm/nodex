-- Harden beta_ledger so it cannot bypass table RLS if it is ever exposed.
-- Supabase/Postgres views are security definer by default unless security_invoker is set.

create or replace view public.beta_ledger
with (security_invoker = on)
as
select
  p.participant_id,
  p.room_id,
  p.name,
  p.email,
  p.city,
  p.country,
  p.network_label,
  p.consent_to_credit,
  p.contribution_note,
  p.invite_token_label,
  p.created_at,
  count(e.id)::integer as evidence_count,
  max(e.created_at) as latest_evidence_at
from public.beta_participants p
left join public.beta_evidence e on e.participant_id = p.participant_id
group by p.id;

revoke all on public.beta_ledger from public;
revoke all on public.beta_ledger from anon;
revoke all on public.beta_ledger from authenticated;
grant select on public.beta_ledger to service_role;
