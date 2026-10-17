alter table public.companies
  add column status text not null default 'active' check (status in ('trial','active','suspended','archived')),
  add column trial_ends_at date,
  add column suspended_at timestamptz,
  add column suspension_reason text,
  add column archived_at timestamptz,
  add column updated_at timestamptz not null default now();

update public.companies set status = case when active then 'active' else 'suspended' end;

create or replace function public.sync_company_active() returns trigger
language plpgsql as $$
begin
  new.active := new.status in ('trial', 'active');
  new.updated_at := now();
  return new;
end;
$$;
create trigger companies_status_active before insert or update of status on public.companies
for each row execute function public.sync_company_active();

alter table public.company_settings
  add column document_template text not null default 'elegant' check (document_template in ('elegant','modern','compact')),
  add column document_secondary_color text not null default '#A5D8FF',
  add column document_config jsonb not null default '{"sections":["itinerary","accommodation","inclusions","exclusions","price","payment","terms"],"labels":{}}'::jsonb,
  add column terms text,
  add column cancellation_policy text,
  add column signature_path text,
  add column company_footer text;

alter table public.integration_accounts
  add column connected_at timestamptz not null default now(),
  add column last_success_at timestamptz,
  add column last_error text;

create table public.platform_settings (
  singleton boolean primary key default true check (singleton),
  monthly_price numeric(12,2) not null default 0 check (monthly_price >= 0),
  annual_price numeric(12,2) not null default 0 check (annual_price >= 0),
  currency text not null default 'INR',
  updated_at timestamptz not null default now()
);
insert into public.platform_settings (singleton) values (true) on conflict do nothing;

create table public.company_subscriptions (
  company_id uuid primary key references public.companies(id) on delete cascade,
  billing_cycle text not null default 'monthly' check (billing_cycle in ('monthly','annual')),
  price numeric(12,2) not null default 0 check (price >= 0),
  started_at date not null default current_date,
  renews_on date,
  payment_status text not null default 'due' check (payment_status in ('trial','paid','due','overdue','waived')),
  notes text,
  updated_at timestamptz not null default now()
);

create table public.platform_subscription_payments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  amount numeric(12,2) not null check (amount > 0),
  paid_at date not null,
  method text not null,
  reference text,
  period_start date,
  period_end date,
  notes text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index platform_payments_company_date_idx on public.platform_subscription_payments(company_id, paid_at desc);

create table public.platform_audit_events (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id),
  target_company_id uuid,
  company_name text,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index platform_audit_created_idx on public.platform_audit_events(created_at desc);

create table public.lead_forms (
  company_id uuid primary key references public.companies(id) on delete cascade,
  public_key text not null unique,
  write_key_hash text,
  active boolean not null default true,
  title text not null default 'Plan your trip',
  success_message text not null default 'Thank you. Our travel team will contact you shortly.',
  primary_color text not null default '#C084FC',
  enabled_fields text[] not null default array['name','phone','email','destination','message'],
  required_fields text[] not null default array['name','phone'],
  allowed_origins text[] not null default '{}',
  source_label text not null default 'Website',
  updated_at timestamptz not null default now()
);

create table public.integration_oauth_states (
  state uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  actor_id uuid not null references auth.users(id) on delete cascade,
  ciphertext text,
  expires_at timestamptz not null default now() + interval '15 minutes',
  created_at timestamptz not null default now()
);
create index oauth_states_expiry_idx on public.integration_oauth_states(expires_at);

alter table public.platform_settings enable row level security;
alter table public.company_subscriptions enable row level security;
alter table public.platform_subscription_payments enable row level security;
alter table public.platform_audit_events enable row level security;
alter table public.lead_forms enable row level security;
alter table public.integration_oauth_states enable row level security;

create policy subscriptions_read on public.company_subscriptions for select to authenticated
  using (public.can_access(company_id, 'company.read'));
create policy lead_forms_read on public.lead_forms for select to authenticated
  using (public.can_access(company_id, 'integrations.read'));
create policy lead_forms_write on public.lead_forms for all to authenticated
  using (public.can_access(company_id, 'integrations.write'))
  with check (public.can_access(company_id, 'integrations.write'));

update public.roles
set permissions = permissions || array['documents.read','documents.write','integrations.read','integrations.write']
where 'settings.write' = any(permissions)
  and not ('documents.write' = any(permissions));
