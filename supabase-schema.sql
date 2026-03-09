-- Ejecuta esto en Supabase → SQL Editor → New query

-- Tabla de predicciones guardadas
create table if not exists predictions (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users(id) on delete cascade,
  created_at timestamptz default now(),
  league text not null,
  home_team text not null,
  away_team text not null,
  predicted_score text,
  pick text,
  odds text,
  confidence int,
  result text default 'pending', -- pending | won | lost
  analysis jsonb,
  parlay boolean default false
);

-- Índices
create index if not exists predictions_user_id_idx on predictions(user_id);
create index if not exists predictions_created_at_idx on predictions(created_at desc);

-- Row Level Security — cada usuario solo ve sus predicciones
alter table predictions enable row level security;

create policy "Users can view own predictions"
  on predictions for select
  using (auth.uid() = user_id);

create policy "Users can insert own predictions"
  on predictions for insert
  with check (auth.uid() = user_id);

create policy "Users can update own predictions"
  on predictions for update
  using (auth.uid() = user_id);

create policy "Users can delete own predictions"
  on predictions for delete
  using (auth.uid() = user_id);
