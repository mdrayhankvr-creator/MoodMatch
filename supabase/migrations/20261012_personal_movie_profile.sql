-- Review and approve this migration before applying it to a Supabase project.
-- Personal data is private to the authenticated owner. Movie IDs are checked
-- against the validated catalogue again by the application before writes.

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Movie fan'
    check (char_length(display_name) between 1 and 80 and display_name !~ '[[:cntrl:]]'),
  avatar_url text
    check (avatar_url is null or (char_length(avatar_url) <= 2048 and
      avatar_url ~ '^https://([a-z0-9-]+\.)*googleusercontent\.com(/|$)')),
  preferences jsonb not null default '{"favoriteGenres":[]}'::jsonb
    check (jsonb_typeof(preferences) = 'object' and octet_length(preferences::text) <= 4096),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per person and stable content ID. The nullable timestamps let a user
-- remove either list independently. Ratings are possible only while watched.
create table public.user_movie_status (
  user_id uuid not null references auth.users(id) on delete cascade,
  content_type text not null default 'movie'
    check (content_type in ('movie', 'tv')),
  content_id text not null,
  watched_at timestamptz,
  watchlisted_at timestamptz,
  rating smallint
    check (rating is null or (rating between 1 and 10 and watched_at is not null)),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, content_type, content_id),
  constraint stable_content_id check (
    (content_type = 'movie' and content_id ~ '^movie_[0-9a-f]{20,64}$') or
    (content_type = 'tv' and content_id ~ '^tv_[0-9a-f]{20,64}$')
  )
);

create index user_movie_status_watched_idx on public.user_movie_status (user_id, watched_at desc)
  where watched_at is not null;
create index user_movie_status_watchlist_idx on public.user_movie_status (user_id, watchlisted_at desc)
  where watchlisted_at is not null;
create index user_movie_status_rating_idx on public.user_movie_status (user_id, rating desc)
  where rating is not null;

alter table public.profiles enable row level security;
alter table public.user_movie_status enable row level security;
revoke all on public.profiles, public.user_movie_status from anon;
grant select, insert, update, delete on public.profiles, public.user_movie_status to authenticated;

create policy profiles_select_own on public.profiles for select to authenticated
  using ((select auth.uid()) = id);
create policy profiles_insert_own on public.profiles for insert to authenticated
  with check ((select auth.uid()) = id);
create policy profiles_update_own on public.profiles for update to authenticated
  using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
create policy profiles_delete_own on public.profiles for delete to authenticated
  using ((select auth.uid()) = id);

create policy status_select_own on public.user_movie_status for select to authenticated
  using ((select auth.uid()) = user_id);
create policy status_insert_own on public.user_movie_status for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy status_update_own on public.user_movie_status for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy status_delete_own on public.user_movie_status for delete to authenticated
  using ((select auth.uid()) = user_id);

-- The trigger runs with its owner's rights only during Auth signup. It has no
-- callable Data API entry point and does not grant users elevated privileges.
create schema if not exists moodmatch_private;
revoke all on schema moodmatch_private from public, anon, authenticated;
create function moodmatch_private.create_personal_profile() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  proposed_name text;
  proposed_avatar text;
begin
  proposed_name := left(trim(regexp_replace(coalesce(new.raw_user_meta_data->>'full_name',
    'Movie fan'), '[[:cntrl:]]', '', 'g')), 80);
  proposed_avatar := new.raw_user_meta_data->>'avatar_url';
  if proposed_avatar is null or char_length(proposed_avatar) > 2048 or
      proposed_avatar !~ '^https://([a-z0-9-]+\.)*googleusercontent\.com(/|$)' then
    proposed_avatar := null;
  end if;
  insert into public.profiles (id, display_name, avatar_url)
    values (new.id, coalesce(nullif(proposed_name, ''), 'Movie fan'), proposed_avatar)
    on conflict (id) do nothing;
  return new;
end;
$$;
revoke all on function moodmatch_private.create_personal_profile() from public, anon, authenticated;
create trigger create_personal_profile after insert on auth.users
  for each row execute function moodmatch_private.create_personal_profile();

create function moodmatch_private.touch_personal_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function moodmatch_private.touch_personal_updated_at() from public, anon, authenticated;
create trigger profiles_updated_at before update on public.profiles
  for each row execute function moodmatch_private.touch_personal_updated_at();
create trigger status_updated_at before update on public.user_movie_status
  for each row execute function moodmatch_private.touch_personal_updated_at();

-- Existing Auth users receive a private profile without changing their account.
insert into public.profiles (id)
  select id from auth.users on conflict (id) do nothing;
