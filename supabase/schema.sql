-- openGym on Supabase. Run once in the SQL editor of the project.
-- Every table is private to its owner (RLS). Nothing here is readable without a signed-in user.

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  rev integer not null default 0,
  wid text,
  doc jsonb not null default '{}'::jsonb,   -- settings, plan, everything that is not a list below
  updated_at timestamptz not null default now()
);

-- One row per entry of each list in the app state; `data` is the entry as the app wrote it.
create table if not exists public.workouts (
  user_id uuid not null references auth.users(id) on delete cascade,
  ord integer not null,
  data jsonb not null,
  primary key (user_id, ord)
);
create table if not exists public.routines (like public.workouts including all);
create table if not exists public.bodyweight (like public.workouts including all);
create table if not exists public.measurements (like public.workouts including all);
alter table public.routines add foreign key (user_id) references auth.users(id) on delete cascade;
alter table public.bodyweight add foreign key (user_id) references auth.users(id) on delete cascade;
alter table public.measurements add foreign key (user_id) references auth.users(id) on delete cascade;

-- Photos and videos: the file lives in Storage (bucket `media`, path <uid>/<sha256>), this
-- table says which ones the profile owns.
create table if not exists public.media (
  user_id uuid not null references auth.users(id) on delete cascade,
  hash text not null,
  mime text not null,
  size integer not null,
  created_at timestamptz not null default now(),
  primary key (user_id, hash)
);
-- Since when no saved state refers to the file (a new upload starts here: the state push that
-- names it comes a moment later). media_sweep() clears it while the file is referenced.
alter table public.media add column if not exists unref_since timestamptz default now();

-- Web Push subscriptions for the rest timer.
create table if not exists public.push_subscriptions (
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null,
  subscription jsonb not null,
  device_id text,   -- the browser that registered it: a rest alert goes to the device that started the rest
  primary key (user_id, endpoint)
);
alter table public.push_subscriptions add column if not exists device_id text;
create table if not exists public.rest_timers (
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null,
  fire_at timestamptz not null,
  title text,
  body text,
  primary key (user_id, endpoint)
);
create index if not exists rest_timers_fire_at on public.rest_timers (fire_at);

alter table public.profiles enable row level security;
alter table public.workouts enable row level security;
alter table public.routines enable row level security;
alter table public.bodyweight enable row level security;
alter table public.measurements enable row level security;
alter table public.media enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.rest_timers enable row level security;

do $$
declare t text;
begin
  foreach t in array array['profiles','workouts','routines','bodyweight','measurements','media','push_subscriptions','rest_timers'] loop
    execute format('drop policy if exists "own rows" on public.%I', t);
    execute format('create policy "own rows" on public.%I for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
end $$;

-- The whole profile as one document, the shape the app already syncs.
create or replace function public.get_state()
returns jsonb language sql stable security invoker as $$
  select jsonb_build_object('rev', coalesce(p.rev, 0), 'state',
    coalesce(p.doc, '{}'::jsonb) || jsonb_build_object(
      'workouts', coalesce((select jsonb_agg(data order by ord) from public.workouts where user_id = auth.uid()), '[]'::jsonb),
      'routines', coalesce((select jsonb_agg(data order by ord) from public.routines where user_id = auth.uid()), '[]'::jsonb),
      'bodyweight', coalesce((select jsonb_agg(data order by ord) from public.bodyweight where user_id = auth.uid()), '[]'::jsonb),
      'measurements', coalesce((select jsonb_agg(data order by ord) from public.measurements where user_id = auth.uid()), '[]'::jsonb)))
  from (select 1) s left join public.profiles p on p.user_id = auth.uid();
$$;

create or replace function public.get_rev()
returns jsonb language sql stable security invoker as $$
  select jsonb_build_object('rev', coalesce(p.rev, 0), 'wid', p.wid)
  from (select 1) s left join public.profiles p on p.user_id = auth.uid();
$$;

-- Conditional write, atomic: a base_rev that is not the stored one means another device wrote
-- in between, and the stored document goes back with the refusal so the app can merge.
-- Returns { ok: true, rev, wid } or { ok: false, conflict: true, rev, state }.
create or replace function public.put_state(base_rev integer, base_wid text, doc jsonb, new_wid text)
returns jsonb language plpgsql security invoker as $$
declare
  uid uuid := auth.uid();
  cur public.profiles%rowtype;
  cur_rev integer;
  stored_reset numeric;
  new_doc jsonb;
  new_rev integer;
  wids jsonb;
begin
  if uid is null then raise exception 'not signed in' using errcode = '28000'; end if;
  insert into public.profiles (user_id) values (uid) on conflict do nothing;
  select * into cur from public.profiles where user_id = uid for update;
  cur_rev := cur.rev;
  if (base_rev is not null and base_rev <> cur_rev)
     or (base_rev is not null and base_wid is not null and cur.wid is not null and base_wid <> cur.wid) then
    return jsonb_build_object('ok', false, 'conflict', true, 'rev', cur_rev, 'state', (public.get_state())->'state');
  end if;

  new_doc := doc - 'workouts' - 'routines' - 'bodyweight' - 'measurements' - 'active';
  -- The reset stamp only moves forward (a backup restored over the profile must not undo it).
  stored_reset := coalesce((cur.doc->>'resetAt')::numeric, 0);
  if stored_reset > coalesce((new_doc->>'resetAt')::numeric, 0) then
    new_doc := new_doc || jsonb_build_object('resetAt', cur.doc->'resetAt');
    if cur.doc ? 'resetIds' then new_doc := new_doc || jsonb_build_object('resetIds', cur.doc->'resetIds');
    else new_doc := new_doc - 'resetIds'; end if;
  end if;

  new_rev := cur_rev + 1;
  wids := coalesce(cur.doc->'_wids', '[]'::jsonb);
  if cur.wid is not null then wids := wids || to_jsonb(cur.wid); end if;
  new_doc := new_doc || jsonb_build_object(
    '_rev', new_rev, '_wid', new_wid,
    '_wids', (select coalesce(jsonb_agg(x order by o), '[]'::jsonb) from (
        select x, o from jsonb_array_elements(wids) with ordinality as t(x, o) order by o desc limit 40) q));

  update public.profiles set rev = new_rev, wid = new_wid, doc = new_doc, updated_at = now() where user_id = uid;

  delete from public.workouts where user_id = uid;
  insert into public.workouts (user_id, ord, data)
    select uid, (o - 1)::int, e from jsonb_array_elements(coalesce(doc->'workouts', '[]'::jsonb)) with ordinality as t(e, o) where jsonb_typeof(e) = 'object';
  delete from public.routines where user_id = uid;
  insert into public.routines (user_id, ord, data)
    select uid, (o - 1)::int, e from jsonb_array_elements(coalesce(doc->'routines', '[]'::jsonb)) with ordinality as t(e, o) where jsonb_typeof(e) = 'object';
  delete from public.bodyweight where user_id = uid;
  insert into public.bodyweight (user_id, ord, data)
    select uid, (o - 1)::int, e from jsonb_array_elements(coalesce(doc->'bodyweight', '[]'::jsonb)) with ordinality as t(e, o) where jsonb_typeof(e) = 'object';
  delete from public.measurements where user_id = uid;
  insert into public.measurements (user_id, ord, data)
    select uid, (o - 1)::int, e from jsonb_array_elements(coalesce(doc->'measurements', '[]'::jsonb)) with ordinality as t(e, o) where jsonb_typeof(e) = 'object';

  return jsonb_build_object('ok', true, 'rev', new_rev, 'wid', new_wid, 'ts', new_doc->'_ts');
end $$;

-- Storage: one private bucket, each user only in their own folder.
insert into storage.buckets (id, name, public) values ('media', 'media', false) on conflict do nothing;
drop policy if exists "media own folder" on storage.objects;
create policy "media own folder" on storage.objects for all to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text);

-- Files only. 50 MB is the Free plan's cap on one upload (and the app's videoMB); raise both
-- together on a paid plan. Photos and GIFs are held to their own, smaller caps by the app.
update storage.buckets set
  file_size_limit = 52428800,
  allowed_mime_types = array['image/jpeg','image/png','image/webp','image/gif','video/mp4','video/quicktime','video/webm']
where id = 'media';

-- The sweep: `refs` are the hashes the stored state refers to. Marks the files outside it, clears
-- the mark of the ones inside, and returns the ones unreferenced for longer than grace_ms. The
-- app then deletes those from Storage and from public.media.
create or replace function public.media_sweep(refs text[], grace_ms integer default 3600000)
returns setof public.media language plpgsql security invoker as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'not signed in' using errcode = '28000'; end if;
  update public.media m set unref_since = null
    where m.user_id = uid and m.hash = any(refs) and m.unref_since is not null;
  update public.media m set unref_since = now()
    where m.user_id = uid and not (m.hash = any(refs)) and m.unref_since is null;
  return query select * from public.media m
    where m.user_id = uid and m.unref_since is not null
      and m.unref_since <= now() - make_interval(secs => grace_ms / 1000.0);
end $$;
