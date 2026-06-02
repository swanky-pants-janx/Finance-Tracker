-- Run this once in your Supabase SQL Editor (Dashboard → SQL Editor → New Query)
-- Creates the fintrack_data table isolated from any other tables in your project.

create table if not exists fintrack_data (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  data       jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

-- One row per user
create unique index if not exists fintrack_data_user_id_idx on fintrack_data(user_id);

-- Row Level Security: users can only read/write their own row
alter table fintrack_data enable row level security;

create policy "Users can read own data"
  on fintrack_data for select
  using (auth.uid() = user_id);

create policy "Users can insert own data"
  on fintrack_data for insert
  with check (auth.uid() = user_id);

create policy "Users can update own data"
  on fintrack_data for update
  using (auth.uid() = user_id);
