create table if not exists public.company_settings (
  company_id uuid primary key references public.companies(id) on delete cascade,
  sector text, systems jsonb not null default '[]'::jsonb,
  approval_rules text, approver_mapping text, writing_tone text,
  preferred_language text not null default 'az',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id) on delete cascade,
  employee_id uuid references public.employees(id) on delete set null, title text not null, detail text,
  priority text not null default 'B' check (priority in ('A','B','C')), due_at timestamptz,
  assigned_to uuid references public.employees(id) on delete set null,
  status text not null default 'waiting' check (status in ('today','overdue','waiting','completed')),
  next_step text, source text not null default 'manual', created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists tasks_company_status_idx on public.tasks(company_id,status);
create index if not exists tasks_company_due_idx on public.tasks(company_id,due_at);
alter table public.company_settings enable row level security;
alter table public.tasks enable row level security;
