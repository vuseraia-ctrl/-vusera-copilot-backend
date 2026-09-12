-- VUSERA AI Growth Agency — Supabase migration
create extension if not exists pgcrypto;

create table if not exists growth_campaigns (
  id uuid primary key default gen_random_uuid(), company_id uuid not null references companies(id) on delete cascade,
  created_by uuid references employees(id) on delete set null, name text not null, objective text,
  status text not null default 'draft' check (status in ('draft','active','paused','completed')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists growth_leads (
  id uuid primary key default gen_random_uuid(), company_id uuid not null references companies(id) on delete cascade,
  campaign_id uuid references growth_campaigns(id) on delete set null, created_by uuid references employees(id) on delete set null,
  priority text not null default 'B' check (priority in ('A','B','C')), company_name text not null, sector text,
  contact_name text, contact_role text, contact_email text, primary_channel text not null default 'LinkedIn', website text,
  why_fit text, pilot_scenario text, status text not null default 'Əlaqə qurulmayıb', next_step text,
  last_contact_at timestamptz, demo_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists growth_agent_runs (
  id uuid primary key default gen_random_uuid(), company_id uuid not null references companies(id) on delete cascade,
  started_by uuid references employees(id) on delete set null, run_type text not null,
  status text not null default 'running' check (status in ('running','completed','failed','cancelled')),
  input jsonb not null default '{}'::jsonb, output jsonb not null default '{}'::jsonb, error text,
  created_at timestamptz not null default now(), completed_at timestamptz
);

create table if not exists growth_drafts (
  id uuid primary key default gen_random_uuid(), company_id uuid not null references companies(id) on delete cascade,
  lead_id uuid not null references growth_leads(id) on delete cascade, agent_run_id uuid references growth_agent_runs(id) on delete set null,
  created_by uuid references employees(id) on delete set null, channel text not null, subject text, body text not null,
  status text not null default 'draft' check (status in ('draft','pending_approval','approved','rejected','sent','failed')),
  risk_level text not null default 'medium' check (risk_level in ('low','medium','high')), rejection_reason text,
  approved_by uuid references employees(id) on delete set null, approved_at timestamptz, sent_at timestamptz,
  ai_model text, input_tokens integer, output_tokens integer, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table if not exists growth_approvals (
  id uuid primary key default gen_random_uuid(), company_id uuid not null references companies(id) on delete cascade,
  draft_id uuid not null references growth_drafts(id) on delete cascade, approver_id uuid references employees(id) on delete set null,
  decision text not null check (decision in ('approved','rejected')), reason text, created_at timestamptz not null default now()
);

create table if not exists growth_activities (
  id uuid primary key default gen_random_uuid(), company_id uuid not null references companies(id) on delete cascade,
  employee_id uuid references employees(id) on delete set null, event_type text not null, description text not null,
  metadata jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);

create index if not exists growth_leads_company_status_idx on growth_leads(company_id, status);
create index if not exists growth_leads_company_priority_idx on growth_leads(company_id, priority);
create index if not exists growth_drafts_company_status_idx on growth_drafts(company_id, status);
create index if not exists growth_runs_company_created_idx on growth_agent_runs(company_id, created_at desc);
create index if not exists growth_activities_company_created_idx on growth_activities(company_id, created_at desc);

alter table growth_campaigns enable row level security;
alter table growth_leads enable row level security;
alter table growth_agent_runs enable row level security;
alter table growth_drafts enable row level security;
alter table growth_approvals enable row level security;
alter table growth_activities enable row level security;

-- Backend service-role istifadə edir; istifadəçi trafiki requireAuth + company_id ilə məhdudlaşdırılır.
