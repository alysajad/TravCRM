create table public.catalog_locations (
  id uuid primary key default gen_random_uuid(),
  catalog_key text not null unique,
  name text not null,
  region text not null check (region in ('Kashmir','Ladakh')),
  locality text,
  aliases text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index catalog_locations_name_search_idx on public.catalog_locations using gin (name gin_trgm_ops);
create index catalog_locations_aliases_idx on public.catalog_locations using gin (aliases);
create unique index catalog_locations_normalized_key_idx on public.catalog_locations(lower(catalog_key));

create table public.catalog_day_plans (
  id uuid primary key default gen_random_uuid(),
  catalog_key text not null unique,
  title text not null,
  region text not null check (region in ('Kashmir','Ladakh','Combined')),
  location_id uuid references public.catalog_locations(id) on delete restrict,
  description text not null,
  route_destination text,
  image_path text,
  warning text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index catalog_day_plans_search_idx on public.catalog_day_plans using gin ((title || ' ' || description) gin_trgm_ops);

create table public.catalog_itinerary_templates (
  id uuid primary key default gen_random_uuid(),
  catalog_key text not null unique,
  title text not null,
  region text not null check (region in ('Kashmir','Ladakh','Combined')),
  duration integer not null check (duration between 3 and 10),
  theme text not null,
  season_tags text[] not null default '{}',
  gateway text not null,
  route_label text not null,
  warnings text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index catalog_templates_filter_idx on public.catalog_itinerary_templates(duration, region, theme);

create table public.catalog_template_days (
  template_id uuid not null references public.catalog_itinerary_templates(id) on delete cascade,
  day_number integer not null check (day_number between 1 and 10),
  day_plan_id uuid not null references public.catalog_day_plans(id) on delete restrict,
  overnight_location_id uuid references public.catalog_locations(id) on delete restrict,
  primary key (template_id, day_number)
);

create table public.catalog_hotels (
  id uuid primary key default gen_random_uuid(),
  catalog_key text not null unique,
  canonical_name text not null,
  aliases text[] not null default '{}',
  region text not null check (region in ('Kashmir','Ladakh')),
  location_id uuid not null references public.catalog_locations(id) on delete restrict,
  locality text,
  property_type text not null,
  source_url text not null,
  source_type text not null,
  verified_on date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index catalog_hotels_location_idx on public.catalog_hotels(location_id, property_type);
create index catalog_hotels_name_search_idx on public.catalog_hotels using gin (canonical_name gin_trgm_ops);
create index catalog_hotels_locality_search_idx on public.catalog_hotels using gin (locality gin_trgm_ops);
create index catalog_hotels_aliases_idx on public.catalog_hotels using gin (aliases);
create unique index catalog_hotels_normalized_name_location_idx on public.catalog_hotels(location_id, regexp_replace(lower(canonical_name), '[^a-z0-9]+', '', 'g'));

create table public.company_hotel_overrides (
  company_id uuid not null references public.companies(id) on delete cascade,
  catalog_hotel_id uuid not null references public.catalog_hotels(id) on delete cascade,
  preferred boolean not null default false,
  hidden boolean not null default false,
  negotiated_rate numeric(12,2) check (negotiated_rate is null or negotiated_rate >= 0),
  category text,
  contact_name text,
  contact_phone text,
  contact_email text,
  notes text,
  image_path text,
  updated_at timestamptz not null default now(),
  primary key (company_id, catalog_hotel_id)
);

alter table public.catalog_locations enable row level security;
alter table public.catalog_day_plans enable row level security;
alter table public.catalog_itinerary_templates enable row level security;
alter table public.catalog_template_days enable row level security;
alter table public.catalog_hotels enable row level security;
alter table public.company_hotel_overrides enable row level security;

create policy catalog_locations_read on public.catalog_locations for select to authenticated using (true);
create policy catalog_day_plans_read on public.catalog_day_plans for select to authenticated using (true);
create policy catalog_templates_read on public.catalog_itinerary_templates for select to authenticated using (true);
create policy catalog_template_days_read on public.catalog_template_days for select to authenticated using (true);
create policy catalog_hotels_read on public.catalog_hotels for select to authenticated using (true);
create policy company_hotel_overrides_read on public.company_hotel_overrides for select to authenticated using (
  public.can_access(company_id, 'hotel.read') or public.can_access(company_id, 'quotes.read') or public.can_access(company_id, 'quotes.write')
);
create policy company_hotel_overrides_write on public.company_hotel_overrides for all to authenticated using (public.can_access(company_id, 'hotel.write')) with check (public.can_access(company_id, 'hotel.write'));

comment on table public.catalog_hotels is 'Shared durable property facts only. Commercial data belongs in company_hotel_overrides.';
