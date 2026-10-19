-- Platform governance for the durable travel catalog introduced in 0009.
alter table public.catalog_hotels alter column source_url drop not null;
alter table public.catalog_hotels alter column source_type drop not null;
alter table public.catalog_hotels alter column verified_on drop not null;

alter table public.records drop constraint if exists records_type_check;
alter table public.records add constraint records_type_check check (type in (
  'lead_source','client','query','follow_up','day_plan','hotel_category',
  'room_type','hotel','cab','expense','invoice','stay_voucher','cab_voucher',
  'lead','partner','voucher_inclusion','other_catalog','hotel_payment',
  'location','itinerary_template','property_type'
));

create table public.catalog_entries (
  id uuid primary key default gen_random_uuid(),
  catalog_type text not null check (catalog_type in (
    'hotel','location','day_plan','itinerary_template','room_type',
    'property_type','hotel_category','voucher_inclusion'
  )),
  source_id uuid not null,
  normalized_key text not null,
  title text not null,
  active boolean not null default true,
  availability_mode text not null default 'all' check (availability_mode in ('all','selected')),
  provenance text not null default 'platform' check (provenance in ('seed','platform','company')),
  source_company_id uuid references public.companies(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (catalog_type, source_id),
  unique (catalog_type, normalized_key)
);
create index catalog_entries_list_idx on public.catalog_entries(catalog_type, active, title);

create table public.catalog_options (
  id uuid primary key default gen_random_uuid(),
  option_type text not null check (option_type in ('room_type','property_type','hotel_category','voucher_inclusion')),
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (option_type, name)
);

create table public.catalog_company_access (
  catalog_entry_id uuid not null references public.catalog_entries(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  included boolean not null,
  updated_at timestamptz not null default now(),
  primary key (catalog_entry_id, company_id)
);
create index catalog_company_access_company_idx on public.catalog_company_access(company_id, included);

create table public.catalog_submissions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  source_record_id uuid not null references public.records(id) on delete cascade,
  item_type text not null check (item_type in (
    'hotel','location','day_plan','itinerary_template','room_type',
    'property_type','hotel_category','voucher_inclusion'
  )),
  operation text not null check (operation in ('create','update')),
  snapshot jsonb not null,
  status text not null default 'pending' check (status in ('pending','approved','merged','rejected')),
  target_entry_id uuid references public.catalog_entries(id) on delete set null,
  reviewer_id uuid references auth.users(id) on delete set null,
  reason text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index catalog_submissions_one_pending_idx on public.catalog_submissions(source_record_id) where status = 'pending';
create index catalog_submissions_queue_idx on public.catalog_submissions(status, created_at);
create index catalog_submissions_company_idx on public.catalog_submissions(company_id, created_at desc);

-- Stable registry IDs mirror the stable IDs of the seeded source rows.
insert into public.catalog_entries(id,catalog_type,source_id,normalized_key,title,provenance)
select id,'location',id,lower(catalog_key),name,'seed' from public.catalog_locations on conflict do nothing;
insert into public.catalog_entries(id,catalog_type,source_id,normalized_key,title,provenance)
select id,'day_plan',id,lower(catalog_key),title,'seed' from public.catalog_day_plans on conflict do nothing;
insert into public.catalog_entries(id,catalog_type,source_id,normalized_key,title,provenance)
select id,'itinerary_template',id,lower(catalog_key),title,'seed' from public.catalog_itinerary_templates on conflict do nothing;
insert into public.catalog_entries(id,catalog_type,source_id,normalized_key,title,provenance)
select id,'hotel',id,regexp_replace(lower(canonical_name), '[^a-z0-9]+', '', 'g') || ':' || location_id::text,canonical_name,'seed'
from public.catalog_hotels on conflict do nothing;

insert into public.catalog_options(option_type,name) values
  ('room_type','Standard Room'),('room_type','Deluxe Room'),('room_type','Suite'),('room_type','Family Room'),('room_type','Tent'),
  ('property_type','Hotel'),('property_type','Houseboat'),('property_type','Resort'),('property_type','Guest house'),('property_type','Homestay'),('property_type','Camp'),('property_type','Cottage'),
  ('hotel_category','Budget'),('hotel_category','Standard'),('hotel_category','Deluxe'),('hotel_category','Luxury'),
  ('voucher_inclusion','Breakfast'),('voucher_inclusion','Dinner'),('voucher_inclusion','Airport transfer'),('voucher_inclusion','Sightseeing')
on conflict do nothing;
insert into public.catalog_entries(id,catalog_type,source_id,normalized_key,title,provenance)
select id,option_type,id,regexp_replace(lower(name), '[^a-z0-9]+', '', 'g'),name,'platform'
from public.catalog_options on conflict do nothing;

alter table public.catalog_entries enable row level security;
alter table public.catalog_options enable row level security;
alter table public.catalog_company_access enable row level security;
alter table public.catalog_submissions enable row level security;

create or replace function public.catalog_entry_available(p_entry_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_platform_admin() or exists (
    select 1 from public.catalog_entries e
    join public.memberships m on m.user_id = auth.uid() and m.active
    left join public.catalog_company_access a on a.catalog_entry_id = e.id and a.company_id = m.company_id
    where e.id = p_entry_id and e.active and (
      (e.availability_mode = 'all' and coalesce(a.included, true)) or
      (e.availability_mode = 'selected' and a.included = true)
    )
  );
$$;

create policy catalog_entries_read on public.catalog_entries for select to authenticated using (public.catalog_entry_available(id));
create policy catalog_options_read on public.catalog_options for select to authenticated using (
  exists (select 1 from public.catalog_entries e where e.catalog_type = catalog_options.option_type and e.source_id = catalog_options.id and public.catalog_entry_available(e.id))
);
create policy catalog_company_access_read on public.catalog_company_access for select to authenticated using (
  public.is_platform_admin() or public.can_access(company_id, 'quotes.read')
);
create policy catalog_submissions_read on public.catalog_submissions for select to authenticated using (
  public.is_platform_admin() or public.can_access(company_id, 'day_plan.read') or public.can_access(company_id, 'hotel.read')
);

drop policy catalog_locations_read on public.catalog_locations;
drop policy catalog_day_plans_read on public.catalog_day_plans;
drop policy catalog_templates_read on public.catalog_itinerary_templates;
drop policy catalog_template_days_read on public.catalog_template_days;
drop policy catalog_hotels_read on public.catalog_hotels;
create policy catalog_locations_read on public.catalog_locations for select to authenticated using (
  exists (select 1 from public.catalog_entries e where e.catalog_type = 'location' and e.source_id = catalog_locations.id and public.catalog_entry_available(e.id))
);
create policy catalog_day_plans_read on public.catalog_day_plans for select to authenticated using (
  exists (select 1 from public.catalog_entries e where e.catalog_type = 'day_plan' and e.source_id = catalog_day_plans.id and public.catalog_entry_available(e.id))
);
create policy catalog_templates_read on public.catalog_itinerary_templates for select to authenticated using (
  exists (select 1 from public.catalog_entries e where e.catalog_type = 'itinerary_template' and e.source_id = catalog_itinerary_templates.id and public.catalog_entry_available(e.id))
);
create policy catalog_template_days_read on public.catalog_template_days for select to authenticated using (
  exists (select 1 from public.catalog_entries e where e.catalog_type = 'itinerary_template' and e.source_id = catalog_template_days.template_id and public.catalog_entry_available(e.id))
);
create policy catalog_hotels_read on public.catalog_hotels for select to authenticated using (
  exists (select 1 from public.catalog_entries e where e.catalog_type = 'hotel' and e.source_id = catalog_hotels.id and public.catalog_entry_available(e.id))
);

comment on table public.catalog_entries is 'Governance registry. Seed upserts must never overwrite active or availability_mode.';
comment on table public.catalog_submissions is 'Durable-field review snapshots; private rates, contacts, notes and images are excluded.';
