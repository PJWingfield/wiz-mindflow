-- Fixture of the OBSERVED Supabase baseline (read-only audit), not the production DDL itself.
-- Fidelity notes: user_documents columns, policy names/expressions and updated_at trigger bodies are
-- stand-ins (the audit recorded only that they exist). Everything else follows the audited description.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text);
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;

grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

create function public.update_updated_at_column() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create table public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text,
  avatar_url text,
  subscription_status text not null default 'inactive'
    check (subscription_status in ('inactive', 'active', 'past_due', 'canceled', 'beta')),
  subscription_tier text default 'free' check (subscription_tier in ('free', 'pro', 'unlimited')),
  stripe_customer_id text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  title text not null default 'New Conversation',
  is_archived boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender text not null check (sender in ('user', 'assistant', 'system')),
  content text not null,
  tokens_used integer default 0,
  created_at timestamptz default now()
);
create table public.user_documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  created_at timestamptz default now()
);

create trigger update_users_updated_at before update on public.users for each row execute function public.update_updated_at_column();
create trigger update_conversations_updated_at before update on public.conversations for each row execute function public.update_updated_at_column();

alter table public.users enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.user_documents enable row level security;

create policy users_select_own on public.users for select using (auth.uid() = id);
create policy users_update_own on public.users for update using (auth.uid() = id);
create policy conversations_select_own on public.conversations for select using (auth.uid() = user_id);
create policy conversations_insert_own on public.conversations for insert with check (auth.uid() = user_id);
create policy conversations_update_own on public.conversations for update using (auth.uid() = user_id);
create policy conversations_delete_own on public.conversations for delete using (auth.uid() = user_id);
create policy messages_select_own on public.messages for select
  using (exists (select 1 from public.conversations c where c.id = conversation_id and c.user_id = auth.uid()));
create policy messages_insert_own on public.messages for insert
  with check (exists (select 1 from public.conversations c where c.id = conversation_id and c.user_id = auth.uid()));
