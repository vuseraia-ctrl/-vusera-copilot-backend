-- VUSERA Employee Copilot — Supabase Database Schema
-- Bunu Supabase-də: SQL Editor -> New Query -> yapışdırıb "Run" edin.

-- 1) pgvector uzantısını aktivləşdir (Supabase-də adətən hazırdır)
create extension if not exists vector;

-- 2) Şirkətlər (multi-tenant üçün, gələcəkdə çoxlu müştəri üçün)
create table companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz default now()
);

-- 3) Departamentlər
create table departments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete cascade,
  name text not null
);

-- 4) İşçilər (rol-əsaslı icazə üçün)
create table employees (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete cascade,
  department_id uuid references departments(id),
  name text not null,
  email text unique,
  role text not null, -- 'Employee', 'Manager', 'HR Manager', 'Finance Manager', 'Admin'
  created_at timestamptz default now()
);

-- 5) Sənədlər (yüklənən PDF/Word fayllar)
create table documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete cascade,
  department_id uuid references departments(id),
  title text not null,
  doc_code text, -- misal: "HR-002"
  -- kimlərə açıqdır: boşdursa hamıya açıqdır, doludursa yalnız bu rollara
  restricted_to_roles text[] default '{}',
  uploaded_at timestamptz default now()
);

-- 6) Sənəd parçaları (chunks) — hər birinin öz embedding-i var
create table document_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid references documents(id) on delete cascade,
  section_label text, -- misal: "Section 4.2"
  content text not null,
  embedding vector(1024), -- Voyage AI voyage-2 modeli 1024 ölçülü embedding verir
  created_at timestamptz default now()
);

-- Vector axtarışını sürətləndirən indeks
create index on document_chunks using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- 7) Əməliyyat sorğuları (leave request, IT ticket, expense request)
create table action_requests (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete cascade,
  employee_id uuid references employees(id),
  type text not null, -- 'leave_request' | 'it_ticket' | 'expense_request'
  title text,
  detail text,
  status text default 'created', -- 'created' | 'approved' | 'rejected' | 'resolved'
  created_at timestamptz default now()
);

-- 8) Söhbət tarixçəsi (analitika üçün — "top questions" dashboard-u)
create table chat_logs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete cascade,
  employee_id uuid references employees(id),
  question text,
  answer text,
  source_type text, -- 'answer' | 'summary' | 'denied' | 'not_found' | 'action'
  created_at timestamptz default now()
);

-- Vector oxşarlıq axtarışı üçün funksiya
create or replace function match_chunks (
  query_embedding vector(1024),
  match_company_id uuid,
  match_count int default 4
)
returns table (
  chunk_id uuid,
  document_id uuid,
  document_title text,
  doc_code text,
  restricted_to_roles text[],
  section_label text,
  content text,
  similarity float
)
language sql stable
as $$
  select
    dc.id as chunk_id,
    d.id as document_id,
    d.title as document_title,
    d.doc_code,
    d.restricted_to_roles,
    dc.section_label,
    dc.content,
    1 - (dc.embedding <=> query_embedding) as similarity
  from document_chunks dc
  join documents d on d.id = dc.document_id
  where d.company_id = match_company_id
  order by dc.embedding <=> query_embedding
  limit match_count;
$$;
