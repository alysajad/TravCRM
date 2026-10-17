-- Canonical customer identity, immutable business snapshots, and customer activity.

create or replace function public.normalize_client_email(value text) returns text
language sql immutable parallel safe as $$ select lower(trim(coalesce(value, ''))) $$;

create or replace function public.normalize_client_phone(value text) returns text
language sql immutable parallel safe as $$ select regexp_replace(coalesce(value, ''), '[^0-9]', '', 'g') $$;

alter table public.quotes add column client_id uuid;
alter table public.quotes add constraint quotes_client_fk foreign key (client_id, company_id)
  references public.records(id, company_id) on delete restrict;
create index quotes_company_client_idx on public.quotes(company_id, client_id, created_at desc);

alter table public.bookings add column client_id uuid;
alter table public.bookings add constraint bookings_client_fk foreign key (client_id, company_id)
  references public.records(id, company_id) on delete restrict;
create index bookings_company_client_idx on public.bookings(company_id, client_id, confirmed_at desc);

update public.records set data = data || jsonb_build_object(
  'email_normalized', public.normalize_client_email(data->>'email'),
  'phone_normalized', public.normalize_client_phone(data->>'phone')
) where type = 'client';

create or replace function public.normalize_client_record() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.type = 'client' then
    new.data := new.data || jsonb_build_object(
      'email_normalized', public.normalize_client_email(new.data->>'email'),
      'phone_normalized', public.normalize_client_phone(new.data->>'phone')
    );
  end if;
  return new;
end;
$$;
create trigger records_normalize_client before insert or update of data on public.records
for each row execute function public.normalize_client_record();

create index records_client_email_normalized_idx on public.records(company_id, (data->>'email_normalized'))
  where type = 'client' and data->>'email_normalized' <> '';
create index records_client_phone_normalized_idx on public.records(company_id, (data->>'phone_normalized'))
  where type = 'client' and data->>'phone_normalized' <> '';
create index records_query_client_idx on public.records(company_id, (data->>'client_id'))
  where type = 'query' and data ? 'client_id';

-- A union of phone and email candidates must resolve to one and only one customer.
with matches as (
  select query.id, min(client.id::text)::uuid as client_id
  from public.records query
  join public.records client on client.company_id = query.company_id and client.type = 'client'
    and (
      (public.normalize_client_email(query.data->>'email') <> '' and client.data->>'email_normalized' = public.normalize_client_email(query.data->>'email')) or
      (public.normalize_client_phone(query.data->>'phone') <> '' and client.data->>'phone_normalized' = public.normalize_client_phone(query.data->>'phone'))
    )
  where query.type = 'query' and not (query.data ? 'client_id')
  group by query.id having count(distinct client.id) = 1
)
update public.records query set data = jsonb_set(query.data, '{client_id}', to_jsonb(matches.client_id::text), true)
from matches where query.id = matches.id;

update public.quotes quote set client_id = (query.data->>'client_id')::uuid
from public.records query
where quote.query_id = query.id and quote.company_id = query.company_id and query.type = 'query'
  and query.data ? 'client_id' and quote.client_id is null;

with matches as (
  select quote.id, min(client.id::text)::uuid as client_id
  from public.quotes quote
  join public.records client on client.company_id = quote.company_id and client.type = 'client'
    and (
      (public.normalize_client_email(quote.email) <> '' and client.data->>'email_normalized' = public.normalize_client_email(quote.email)) or
      (public.normalize_client_phone(quote.phone) <> '' and client.data->>'phone_normalized' = public.normalize_client_phone(quote.phone))
    )
  where quote.client_id is null
  group by quote.id having count(distinct client.id) = 1
)
update public.quotes quote set client_id = matches.client_id from matches where quote.id = matches.id;

update public.bookings booking set client_id = quote.client_id
from public.quotes quote
where booking.source_quote_id = quote.id and booking.company_id = quote.company_id and quote.client_id is not null;

create table public.client_activities (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  client_id uuid not null,
  type text not null check (type in ('note','call')),
  body text not null check (length(trim(body)) > 0),
  direction text check (direction in ('incoming','outgoing')),
  outcome text check (outcome in ('connected','no_answer','left_message','callback_requested')),
  occurred_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  foreign key (client_id, company_id) references public.records(id, company_id) on delete cascade,
  check ((type = 'note' and direction is null and outcome is null) or (type = 'call' and direction is not null and outcome is not null))
);
create index client_activities_client_time_idx on public.client_activities(company_id, client_id, occurred_at desc);
alter table public.client_activities enable row level security;
create policy client_activities_read on public.client_activities for select to authenticated
  using (public.can_access(company_id, 'client.read'));
create policy client_activities_insert on public.client_activities for insert to authenticated
  with check (public.can_access(company_id, 'client.write'));
create policy client_activities_delete on public.client_activities for delete to authenticated
  using (public.can_access(company_id, 'client.write'));

create or replace function public.sync_booking_client() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.source_quote_id is not null then
    select client_id into new.client_id from public.quotes
      where id = new.source_quote_id and company_id = new.company_id;
  end if;
  return new;
end;
$$;
create trigger bookings_sync_client before insert or update of source_quote_id on public.bookings
for each row execute function public.sync_booking_client();

create or replace function public.propagate_quote_client() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.bookings set client_id = new.client_id
    where company_id = new.company_id and quote_series_id = new.quote_series_id;
  return new;
end;
$$;
create trigger quotes_propagate_client after update of client_id on public.quotes
for each row when (old.client_id is distinct from new.client_id) execute function public.propagate_quote_client();

create or replace function public.prevent_linked_client_delete() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.type = 'client' and (
    exists (select 1 from public.records where company_id = old.company_id and type = 'query' and data->>'client_id' = old.id::text) or
    exists (select 1 from public.quotes where company_id = old.company_id and client_id = old.id) or
    exists (select 1 from public.bookings where company_id = old.company_id and client_id = old.id)
  ) then
    raise exception 'Linked clients cannot be deleted. Mark this client inactive instead.' using errcode = '23503';
  end if;
  return old;
end;
$$;
create trigger records_prevent_linked_client_delete before delete on public.records
for each row execute function public.prevent_linked_client_delete();
