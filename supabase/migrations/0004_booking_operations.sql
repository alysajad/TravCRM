-- Booking operations: numbered quote revisions, controlled booking snapshots and issued vouchers.

alter table public.company_settings
  add column quote_prefix text not null default 'QT',
  add column booking_prefix text not null default 'BK',
  add column stay_voucher_prefix text not null default 'SV',
  add column cab_voucher_prefix text not null default 'CV';

create table public.document_counters (
  company_id uuid not null references public.companies(id) on delete cascade,
  kind text not null check (kind in ('quote','booking','stay_voucher','cab_voucher')),
  year integer not null,
  last_value integer not null default 0,
  primary key (company_id, kind, year)
);

alter table public.quotes
  add column quote_number text,
  add column quote_revision integer not null default 1 check (quote_revision > 0),
  add column quote_series_id uuid not null default gen_random_uuid(),
  add column supersedes_quote_id uuid references public.quotes(id),
  add column booking_date date,
  add column assignee_id uuid references auth.users(id),
  add column pricing_mode text not null default 'total_package' check (pricing_mode in ('total_package','per_person')),
  add column rooms integer not null default 1 check (rooms >= 0),
  add column extra_beds integer not null default 0 check (extra_beds >= 0),
  add column children_without_bed integer not null default 0 check (children_without_bed >= 0),
  add column price_lines jsonb not null default '[]'::jsonb,
  add column transport jsonb not null default '{}'::jsonb,
  add column locked_at timestamptz;

with numbered as (
  select id, 'QT-' || extract(year from created_at)::integer || '-' ||
    lpad(row_number() over (partition by company_id, extract(year from created_at) order by created_at, id)::text, 4, '0') as value
  from public.quotes
)
update public.quotes q set quote_number = numbered.value from numbered where numbered.id = q.id;

alter table public.quotes alter column quote_number set not null;
alter table public.quotes add constraint quotes_company_number_revision_unique unique (company_id, quote_number, quote_revision);
create index quotes_company_series_idx on public.quotes(company_id, quote_series_id, quote_revision desc);

insert into public.document_counters (company_id, kind, year, last_value)
select company_id, 'quote', extract(year from created_at)::integer, count(*)::integer
from public.quotes group by company_id, extract(year from created_at)
on conflict (company_id, kind, year) do update set last_value = greatest(public.document_counters.last_value, excluded.last_value);

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  booking_number text not null,
  quote_series_id uuid not null,
  source_quote_id uuid not null,
  source_quote_revision integer not null,
  revision integer not null default 1,
  status text not null default 'confirmed' check (status in ('confirmed','in_progress','completed','cancelled')),
  client_name text not null,
  email text,
  phone text,
  destination text not null,
  arrival_date date not null,
  departure_date date not null,
  adults integer not null default 0,
  children integer not null default 0,
  rooms integer not null default 0,
  total_amount numeric(12,2) not null default 0,
  assignee_id uuid references auth.users(id),
  snapshot jsonb not null,
  confirmed_by uuid references auth.users(id),
  confirmed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, company_id),
  unique (company_id, booking_number),
  unique (company_id, quote_series_id),
  foreign key (source_quote_id, company_id) references public.quotes(id, company_id)
);
create index bookings_company_arrival_idx on public.bookings(company_id, arrival_date, status);

alter table public.quotes add column booking_id uuid;
alter table public.quotes add constraint quotes_booking_fk foreign key (booking_id, company_id) references public.bookings(id, company_id);

create table public.booking_revisions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  booking_id uuid not null,
  revision integer not null,
  source_quote_id uuid not null,
  snapshot jsonb not null,
  applied_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (booking_id, revision),
  foreign key (booking_id, company_id) references public.bookings(id, company_id) on delete cascade,
  foreign key (source_quote_id, company_id) references public.quotes(id, company_id)
);

create table public.booking_stays (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  booking_id uuid not null,
  sequence integer not null,
  hotel_id uuid,
  property_name text not null,
  property_type text not null default 'Hotel',
  room_type text,
  check_in date not null,
  check_out date not null,
  rooms integer not null default 1,
  extra_beds integer not null default 0,
  children_without_bed integer not null default 0,
  meal_plan text not null default 'CPAI' check (meal_plan in ('EPAI','CPAI','MAPAI','AP','Jain Food')),
  confirmation_status text not null default 'pending' check (confirmation_status in ('pending','confirmed','cancelled')),
  confirmation_reference text,
  supplier_cost numeric(12,2) not null default 0,
  inclusions text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (booking_id, sequence),
  foreign key (booking_id, company_id) references public.bookings(id, company_id) on delete cascade
);

create table public.booking_transport_days (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  booking_id uuid not null,
  day integer not null,
  service_date date not null,
  destination text not null,
  hotel text,
  cab_id uuid,
  vehicle_type text,
  vehicle_number text,
  driver_name text,
  driver_phone text,
  pickup text,
  dropoff text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (booking_id, day),
  foreign key (booking_id, company_id) references public.bookings(id, company_id) on delete cascade
);

create table public.booking_documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  booking_id uuid not null,
  type text not null check (type in ('stay_voucher','cab_voucher')),
  document_number text not null,
  status text not null default 'draft' check (status in ('draft','issued','cancelled','replaced')),
  stay_sequence integer,
  payload jsonb not null default '{}'::jsonb,
  replaces_document_id uuid references public.booking_documents(id),
  issued_by uuid references auth.users(id),
  issued_at timestamptz,
  cancelled_by uuid references auth.users(id),
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, document_number),
  foreign key (booking_id, company_id) references public.bookings(id, company_id) on delete cascade
);
create index booking_documents_booking_idx on public.booking_documents(company_id, booking_id, type, status);
alter table public.booking_documents add constraint booking_documents_id_company_unique unique (id, company_id);

alter table public.messages add column booking_document_id uuid;
alter table public.messages add constraint messages_booking_document_fk foreign key (booking_document_id, company_id) references public.booking_documents(id, company_id);
do $$
declare constraint_name text;
begin
  select conname into constraint_name from pg_constraint
    where conrelid = 'public.messages'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%quote_id%record_id%'
    limit 1;
  if constraint_name is not null then execute format('alter table public.messages drop constraint %I', constraint_name); end if;
end $$;
alter table public.messages add constraint messages_one_target check (
  (quote_id is not null)::integer + (record_id is not null)::integer + (booking_document_id is not null)::integer = 1
);
create index messages_company_booking_document_idx on public.messages(company_id, booking_document_id, created_at desc);

create or replace function public.next_document_number(p_company_id uuid, p_kind text)
returns text language plpgsql security definer set search_path = public as $$
declare
  y integer := extract(year from current_date)::integer;
  n integer;
  prefix text;
begin
  if p_kind not in ('quote','booking','stay_voucher','cab_voucher') then raise exception 'Invalid document kind'; end if;
  insert into public.document_counters(company_id, kind, year, last_value)
  values (p_company_id, p_kind, y, 1)
  on conflict (company_id, kind, year) do update set last_value = public.document_counters.last_value + 1
  returning last_value into n;
  select case p_kind
    when 'quote' then quote_prefix when 'booking' then booking_prefix
    when 'stay_voucher' then stay_voucher_prefix else cab_voucher_prefix end
  into prefix from public.company_settings where company_id = p_company_id;
  return coalesce(nullif(trim(prefix), ''), upper(left(p_kind, 2))) || '-' || y || '-' || lpad(n::text, 4, '0');
end;
$$;
revoke all on function public.next_document_number(uuid,text) from public, anon, authenticated;
grant execute on function public.next_document_number(uuid,text) to service_role;

create or replace function public.apply_quote_booking(
  p_company_id uuid,
  p_quote_id uuid,
  p_actor_id uuid,
  p_snapshot jsonb,
  p_stays jsonb,
  p_transport jsonb,
  p_documents jsonb
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  q public.quotes%rowtype;
  b public.bookings%rowtype;
  item jsonb;
  replacement uuid;
  next_revision integer;
begin
  select * into q from public.quotes where id = p_quote_id and company_id = p_company_id for update;
  if q.id is null then raise exception 'Quotation not found'; end if;
  if q.booking_id is not null then return q.booking_id; end if;
  if q.status = 'Cancelled' then raise exception 'Cancelled quotations cannot be confirmed'; end if;

  select * into b from public.bookings where company_id = p_company_id and quote_series_id = q.quote_series_id for update;
  if b.id is null then
    insert into public.bookings (
      company_id, booking_number, quote_series_id, source_quote_id, source_quote_revision,
      client_name, email, phone, destination, arrival_date, departure_date, adults, children,
      rooms, total_amount, assignee_id, snapshot, confirmed_by
    ) values (
      p_company_id, public.next_document_number(p_company_id, 'booking'), q.quote_series_id, q.id, q.quote_revision,
      p_snapshot->>'client_name', nullif(p_snapshot->>'email',''), nullif(p_snapshot->>'phone',''),
      p_snapshot->>'destination', (p_snapshot->>'arrival_date')::date, (p_snapshot->>'departure_date')::date,
      coalesce((p_snapshot->>'adults')::integer,0), coalesce((p_snapshot->>'children')::integer,0),
      coalesce((p_snapshot->>'rooms')::integer,0), coalesce((p_snapshot->>'total_amount')::numeric,0),
      nullif(p_snapshot->>'assignee_id','')::uuid, p_snapshot, p_actor_id
    ) returning * into b;
    next_revision := 1;
  else
    if b.status in ('completed','cancelled') then raise exception 'Completed or cancelled bookings cannot be revised'; end if;
    next_revision := b.revision + 1;
    update public.bookings set
      source_quote_id = q.id, source_quote_revision = q.quote_revision, revision = next_revision,
      client_name = p_snapshot->>'client_name', email = nullif(p_snapshot->>'email',''), phone = nullif(p_snapshot->>'phone',''),
      destination = p_snapshot->>'destination', arrival_date = (p_snapshot->>'arrival_date')::date,
      departure_date = (p_snapshot->>'departure_date')::date, adults = coalesce((p_snapshot->>'adults')::integer,0),
      children = coalesce((p_snapshot->>'children')::integer,0), rooms = coalesce((p_snapshot->>'rooms')::integer,0),
      total_amount = coalesce((p_snapshot->>'total_amount')::numeric,0), assignee_id = nullif(p_snapshot->>'assignee_id','')::uuid,
      snapshot = p_snapshot, updated_at = now()
    where id = b.id returning * into b;
    delete from public.booking_documents where booking_id = b.id and status = 'draft';
    delete from public.booking_stays where booking_id = b.id;
    delete from public.booking_transport_days where booking_id = b.id;
  end if;

  insert into public.booking_revisions(company_id, booking_id, revision, source_quote_id, snapshot, applied_by)
  values (p_company_id, b.id, next_revision, q.id, p_snapshot, p_actor_id);

  insert into public.booking_stays (
    company_id, booking_id, sequence, hotel_id, property_name, property_type, room_type,
    check_in, check_out, rooms, extra_beds, children_without_bed, meal_plan, supplier_cost, inclusions
  ) select p_company_id, b.id, x.sequence, x.hotel_id, x.property_name, coalesce(x.property_type,'Hotel'), x.room_type,
      x.check_in, x.check_out, x.rooms, x.extra_beds, x.children_without_bed, coalesce(x.meal_plan,'CPAI'), x.supplier_cost, x.inclusions
    from jsonb_to_recordset(coalesce(p_stays,'[]'::jsonb)) as x(
      sequence integer, hotel_id uuid, property_name text, property_type text, room_type text,
      check_in date, check_out date, rooms integer, extra_beds integer, children_without_bed integer,
      meal_plan text, supplier_cost numeric, inclusions text
    );

  insert into public.booking_transport_days (
    company_id, booking_id, day, service_date, destination, hotel, cab_id, vehicle_type,
    vehicle_number, driver_name, driver_phone, pickup, dropoff
  ) select p_company_id, b.id, x.day, x.service_date, x.destination, x.hotel, x.cab_id, x.vehicle_type,
      x.vehicle_number, x.driver_name, x.driver_phone, x.pickup, x.dropoff
    from jsonb_to_recordset(coalesce(p_transport,'[]'::jsonb)) as x(
      day integer, service_date date, destination text, hotel text, cab_id uuid, vehicle_type text,
      vehicle_number text, driver_name text, driver_phone text, pickup text, dropoff text
    );

  for item in select value from jsonb_array_elements(coalesce(p_documents,'[]'::jsonb)) loop
    replacement := null;
    select id into replacement from public.booking_documents
      where booking_id = b.id and type = item->>'type' and status = 'issued'
        and coalesce(stay_sequence,0) = coalesce((item->>'stay_sequence')::integer,0)
      order by issued_at desc limit 1;
    insert into public.booking_documents(company_id, booking_id, type, document_number, stay_sequence, payload, replaces_document_id)
    values (
      p_company_id, b.id, item->>'type', public.next_document_number(p_company_id, item->>'type'),
      nullif(item->>'stay_sequence','')::integer, item->'payload', replacement
    );
  end loop;

  update public.quotes set status = 'Confirmed', locked_at = now(), booking_id = b.id, updated_at = now()
    where id = q.id and company_id = p_company_id;
  return b.id;
end;
$$;
revoke all on function public.apply_quote_booking(uuid,uuid,uuid,jsonb,jsonb,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.apply_quote_booking(uuid,uuid,uuid,jsonb,jsonb,jsonb,jsonb) to service_role;

create or replace function public.issue_booking_document(p_company_id uuid, p_document_id uuid, p_actor_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare d public.booking_documents%rowtype;
begin
  select * into d from public.booking_documents where id = p_document_id and company_id = p_company_id for update;
  if d.id is null then raise exception 'Document not found'; end if;
  if d.status <> 'draft' then raise exception 'Only draft documents can be issued'; end if;
  if d.replaces_document_id is not null then
    update public.booking_documents set status = 'replaced', cancelled_by = p_actor_id, cancelled_at = now(), updated_at = now()
      where id = d.replaces_document_id and company_id = p_company_id and status = 'issued';
  end if;
  update public.booking_documents set status = 'issued', issued_by = p_actor_id, issued_at = now(), updated_at = now()
    where id = d.id;
  return d.id;
end;
$$;
revoke all on function public.issue_booking_document(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.issue_booking_document(uuid,uuid,uuid) to service_role;

alter table public.document_counters enable row level security;
alter table public.bookings enable row level security;
alter table public.booking_revisions enable row level security;
alter table public.booking_stays enable row level security;
alter table public.booking_transport_days enable row level security;
alter table public.booking_documents enable row level security;

create policy bookings_read on public.bookings for select to authenticated using (public.can_access(company_id, 'bookings.read'));
create policy bookings_write on public.bookings for all to authenticated using (public.can_access(company_id, 'bookings.write')) with check (public.can_access(company_id, 'bookings.write'));
create policy booking_revisions_read on public.booking_revisions for select to authenticated using (public.can_access(company_id, 'bookings.read'));
create policy booking_stays_read on public.booking_stays for select to authenticated using (public.can_access(company_id, 'bookings.read'));
create policy booking_stays_write on public.booking_stays for all to authenticated using (public.can_access(company_id, 'bookings.write')) with check (public.can_access(company_id, 'bookings.write'));
create policy booking_transport_read on public.booking_transport_days for select to authenticated using (public.can_access(company_id, 'bookings.read'));
create policy booking_transport_write on public.booking_transport_days for all to authenticated using (public.can_access(company_id, 'bookings.write')) with check (public.can_access(company_id, 'bookings.write'));
create policy booking_documents_read on public.booking_documents for select to authenticated using (public.can_access(company_id, 'booking_documents.read'));
create policy booking_documents_write on public.booking_documents for all to authenticated
  using (public.can_access(company_id, 'booking_documents.write') or public.can_access(company_id, 'booking_documents.issue'))
  with check (public.can_access(company_id, 'booking_documents.write') or public.can_access(company_id, 'booking_documents.issue'));

update public.roles set permissions = array(
  select distinct permission from unnest(permissions || array['quotes.revise','bookings.read','bookings.write','bookings.confirm','booking_documents.read','booking_documents.write','booking_documents.issue']) permission
)
where '*' <> all(permissions) and 'quotes.write' = any(permissions);

update public.roles set permissions = array(
  select distinct permission from unnest(permissions || array['bookings.read','booking_documents.read']) permission
)
where '*' <> all(permissions) and 'quotes.read' = any(permissions);
