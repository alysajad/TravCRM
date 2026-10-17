create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);

create table public.roles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null,
  permissions text[] not null default '{}',
  unique (company_id, name),
  unique (id, company_id)
);

create table public.memberships (
  user_id uuid primary key references auth.users(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  role_id uuid not null,
  name text not null,
  email text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  foreign key (role_id, company_id) references public.roles(id, company_id)
);
create index memberships_company_idx on public.memberships(company_id);

create or replace function public.is_platform_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid());
$$;

create or replace function public.can_access(p_company_id uuid, p_permission text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_platform_admin() or exists (
    select 1 from public.memberships m
    join public.roles r on r.id = m.role_id and r.company_id = m.company_id
    join public.companies c on c.id = m.company_id
    where m.user_id = auth.uid() and m.active and c.active
      and m.company_id = p_company_id
      and ('*' = any(r.permissions) or p_permission = any(r.permissions))
  );
$$;

create table public.company_settings (
  company_id uuid primary key references public.companies(id) on delete cascade,
  logo_path text,
  brand_name text,
  phone text,
  email text,
  address text,
  gstin text,
  bank_details text,
  document_color text not null default '#C084FC',
  website text,
  social_links jsonb not null default '{}'::jsonb
);

create table public.records (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  type text not null check (type in (
    'lead_source','client','query','follow_up','day_plan','hotel_category',
    'room_type','hotel','cab','expense','invoice','stay_voucher',
    'cab_voucher','lead','partner','voucher_inclusion','other_catalog','hotel_payment'
  )),
  title text not null,
  status text not null default 'Active',
  data jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.records add constraint records_id_company_unique unique (id, company_id);
create index records_company_type_created_idx on public.records(company_id, type, created_at desc);
create index records_company_status_idx on public.records(company_id, type, status);
create index records_data_gin_idx on public.records using gin(data);
create index records_title_search_idx on public.records using gin(title gin_trgm_ops);
create index records_arrival_idx on public.records(company_id, (data->>'arrival_date')) where type = 'query';
create index records_followup_due_idx on public.records(company_id, (data->>'due_date')) where type = 'follow_up';
create unique index records_external_lead_idx on public.records(company_id, (data->>'external_id')) where type = 'lead' and data ? 'external_id';
create unique index records_converted_lead_idx on public.records(company_id, (data->>'source_lead_id')) where type = 'query' and data ? 'source_lead_id';

create table public.quotes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  query_id uuid,
  client_name text not null,
  email text,
  phone text,
  status text not null default 'Draft',
  destination text not null,
  days integer not null check (days between 1 and 60),
  nights integer generated always as (days - 1) stored,
  adults integer not null check (adults >= 0),
  children integer not null check (children >= 0),
  arrival_date date,
  pickup text,
  dropoff text,
  flights text,
  itinerary jsonb not null default '[]'::jsonb,
  stays jsonb not null default '[]'::jsonb,
  inclusions text,
  exclusions text,
  base_amount numeric(12,2) not null default 0,
  child_amount numeric(12,2) not null default 0,
  discount_amount numeric(12,2) not null default 0,
  gst_percent numeric(5,2) not null default 0,
  gst_amount numeric(12,2) not null default 0,
  total_amount numeric(12,2) not null default 0,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, company_id),
  foreign key (query_id, company_id) references public.records(id, company_id) on delete set null (query_id)
);
create index quotes_company_created_idx on public.quotes(company_id, created_at desc);
create index quotes_company_status_idx on public.quotes(company_id, status);
create index quotes_client_search_idx on public.quotes using gin(client_name gin_trgm_ops);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  quote_id uuid not null,
  amount numeric(12,2) not null check (amount > 0),
  paid_at date not null,
  method text not null,
  reference text,
  notes text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  foreign key (quote_id, company_id) references public.quotes(id, company_id)
);
create index payments_company_quote_idx on public.payments(company_id, quote_id);

create or replace function public.prevent_quote_below_paid() returns trigger
language plpgsql security definer set search_path = public as $$
declare already_paid numeric(12,2);
begin
  select coalesce(sum(amount), 0) into already_paid from public.payments
    where quote_id = new.id and company_id = new.company_id;
  if already_paid > new.total_amount then raise exception 'Quotation total cannot be below payments received'; end if;
  return new;
end;
$$;
create trigger quotes_payment_floor before update of total_amount on public.quotes
for each row execute function public.prevent_quote_below_paid();

create or replace function public.prevent_overpayment() returns trigger
language plpgsql security definer set search_path = public as $$
declare quote_total numeric(12,2); already_paid numeric(12,2);
begin
  select total_amount into quote_total from public.quotes
    where id = new.quote_id and company_id = new.company_id for update;
  if quote_total is null then raise exception 'Quotation not found in this company'; end if;
  select coalesce(sum(amount), 0) into already_paid from public.payments
    where quote_id = new.quote_id and company_id = new.company_id
      and (tg_op = 'INSERT' or id <> new.id);
  if already_paid + new.amount > quote_total then raise exception 'Payment exceeds quotation balance'; end if;
  return new;
end;
$$;
create trigger payments_limit before insert or update on public.payments
for each row execute function public.prevent_overpayment();

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  quote_id uuid,
  record_id uuid,
  channel text not null check (channel in ('email','whatsapp')),
  recipient text not null,
  status text not null default 'queued',
  provider_id text,
  request_key uuid,
  error text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  foreign key (quote_id, company_id) references public.quotes(id, company_id),
  foreign key (record_id, company_id) references public.records(id, company_id),
  check ((quote_id is not null)::integer + (record_id is not null)::integer = 1)
);
create index messages_company_quote_idx on public.messages(company_id, quote_id, created_at desc);
create index messages_company_record_idx on public.messages(company_id, record_id, created_at desc);
create unique index messages_provider_id_idx on public.messages(provider_id) where provider_id is not null;
create unique index messages_request_key_idx on public.messages(company_id, request_key) where request_key is not null;

-- These credentials can only be read by trusted server code after a permission check.
create table public.integration_accounts (
  company_id uuid not null references public.companies(id) on delete cascade,
  kind text not null check (kind in ('smtp','whatsapp','facebook')),
  external_id text,
  ciphertext text not null,
  updated_at timestamptz not null default now(),
  primary key (company_id, kind)
);
create index integration_external_idx on public.integration_accounts(kind, external_id);
create unique index integration_external_unique on public.integration_accounts(kind, external_id) where external_id is not null;

create table public.audit_events (
  id bigint generated always as identity primary key,
  company_id uuid references public.companies(id) on delete cascade,
  actor_id uuid references auth.users(id),
  action text not null,
  target_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_company_created_idx on public.audit_events(company_id, created_at desc);

alter table public.companies enable row level security;
alter table public.platform_admins enable row level security;
alter table public.roles enable row level security;
alter table public.memberships enable row level security;
alter table public.company_settings enable row level security;
alter table public.records enable row level security;
alter table public.quotes enable row level security;
alter table public.payments enable row level security;
alter table public.messages enable row level security;
alter table public.integration_accounts enable row level security;
alter table public.audit_events enable row level security;

create policy companies_read on public.companies for select to authenticated
  using (public.can_access(id, 'company.read'));
create policy roles_read on public.roles for select to authenticated
  using (public.can_access(company_id, 'roles.read'));
create policy roles_write on public.roles for all to authenticated
  using (public.can_access(company_id, 'roles.write'))
  with check (public.can_access(company_id, 'roles.write'));
create policy members_read on public.memberships for select to authenticated
  using (user_id = auth.uid() or public.can_access(company_id, 'users.read'));
create policy members_write on public.memberships for all to authenticated
  using (public.can_access(company_id, 'users.write'))
  with check (public.can_access(company_id, 'users.write'));
create policy settings_read on public.company_settings for select to authenticated
  using (public.can_access(company_id, 'company.read'));
create policy settings_write on public.company_settings for all to authenticated
  using (public.can_access(company_id, 'settings.write'))
  with check (public.can_access(company_id, 'settings.write'));
create policy records_read on public.records for select to authenticated
  using (public.can_access(company_id, type || '.read'));
create policy records_write on public.records for all to authenticated
  using (public.can_access(company_id, type || '.write'))
  with check (public.can_access(company_id, type || '.write'));
create policy quotes_read on public.quotes for select to authenticated
  using (public.can_access(company_id, 'quotes.read'));
create policy quotes_write on public.quotes for all to authenticated
  using (public.can_access(company_id, 'quotes.write'))
  with check (public.can_access(company_id, 'quotes.write'));
create policy payments_read on public.payments for select to authenticated
  using (public.can_access(company_id, 'payments.read'));
create policy payments_write on public.payments for all to authenticated
  using (public.can_access(company_id, 'payments.write'))
  with check (public.can_access(company_id, 'payments.write'));
create policy messages_read on public.messages for select to authenticated
  using (public.can_access(company_id, 'messages.read'));
create policy messages_write on public.messages for all to authenticated
  using (public.can_access(company_id, 'messages.write'))
  with check (public.can_access(company_id, 'messages.write'));
create policy audit_read on public.audit_events for select to authenticated
  using (public.can_access(company_id, 'audit.read'));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('crm-private', 'crm-private', false, 10485760, array['image/png','image/jpeg','image/webp','application/pdf'])
on conflict (id) do nothing;
create policy crm_files_read on storage.objects for select to authenticated
  using (bucket_id = 'crm-private' and public.can_access(split_part(name, '/', 1)::uuid, 'files.read'));
create policy crm_files_write on storage.objects for insert to authenticated
  with check (bucket_id = 'crm-private' and public.can_access(split_part(name, '/', 1)::uuid, 'files.write'));
create policy crm_files_update on storage.objects for update to authenticated
  using (bucket_id = 'crm-private' and public.can_access(split_part(name, '/', 1)::uuid, 'files.write'))
  with check (bucket_id = 'crm-private' and public.can_access(split_part(name, '/', 1)::uuid, 'files.write'));
create policy crm_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'crm-private' and public.can_access(split_part(name, '/', 1)::uuid, 'files.write'));
