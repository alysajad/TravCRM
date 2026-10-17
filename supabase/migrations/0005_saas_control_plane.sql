create table public.subscription_plans (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z0-9-]{2,40}$'),
  name text not null,
  description text,
  active boolean not null default true,
  monthly_price numeric(12,2) not null default 0 check (monthly_price >= 0),
  annual_price numeric(12,2) not null default 0 check (annual_price >= 0),
  trial_days integer not null default 14 check (trial_days between 0 and 365),
  limits jsonb not null default '{}'::jsonb,
  features text[] not null default '{}',
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.subscription_plans (code, name, description, monthly_price, annual_price, trial_days, limits, features, display_order)
values
  ('starter', 'Starter', 'For small travel teams beginning with TravCRM.', 1499, 14990, 14,
   '{"team_members":3,"leads_monthly":250,"quotes_monthly":100,"bookings_monthly":50,"storage_mb":250}'::jsonb,
   array['crm','quotations','bookings','documents'], 10),
  ('growth', 'Growth', 'For established agencies that need finance and lead automation.', 3499, 34990, 14,
   '{"team_members":10,"leads_monthly":2000,"quotes_monthly":750,"bookings_monthly":300,"storage_mb":2000}'::jsonb,
   array['crm','quotations','bookings','documents','finance','integrations','custom_branding','reports'], 20),
  ('business', 'Business', 'Full TravCRM access for larger travel operations.', 6999, 69990, 30,
   '{"team_members":30,"leads_monthly":10000,"quotes_monthly":5000,"bookings_monthly":2000,"storage_mb":10000}'::jsonb,
   array['crm','quotations','bookings','documents','finance','integrations','custom_branding','reports','api_access','priority_support'], 30)
on conflict (code) do nothing;

alter table public.company_subscriptions
  add column plan_id uuid references public.subscription_plans(id),
  add column subscription_status text not null default 'active' check (subscription_status in ('trialing','active','past_due','cancelled')),
  add column current_period_start date,
  add column current_period_end date,
  add column cancel_at_period_end boolean not null default false,
  add column limit_overrides jsonb not null default '{}'::jsonb,
  add column feature_overrides jsonb not null default '{}'::jsonb;

update public.company_subscriptions
set plan_id = (select id from public.subscription_plans where code = 'business'),
    subscription_status = case payment_status
      when 'trial' then 'trialing'
      when 'overdue' then 'past_due'
      else 'active'
    end,
    current_period_start = coalesce(current_period_start, started_at),
    current_period_end = coalesce(current_period_end, renews_on);

alter table public.company_subscriptions alter column plan_id set not null;
create index company_subscriptions_plan_idx on public.company_subscriptions(plan_id);

create table public.platform_support_sessions (
  id uuid primary key default gen_random_uuid(),
  platform_admin_id uuid not null references auth.users(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  reason text not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index platform_support_sessions_active_idx on public.platform_support_sessions(platform_admin_id, company_id, expires_at desc);

alter table public.platform_settings
  add column default_trial_days integer not null default 14 check (default_trial_days between 0 and 365),
  add column support_session_minutes integer not null default 60 check (support_session_minutes between 15 and 480),
  add column company_signup_enabled boolean not null default true;

alter table public.subscription_plans enable row level security;
alter table public.platform_support_sessions enable row level security;

create policy subscription_plans_read on public.subscription_plans for select to authenticated using (true);
create policy support_sessions_platform_read on public.platform_support_sessions for select to authenticated
  using (public.is_platform_admin() and platform_admin_id = auth.uid());

