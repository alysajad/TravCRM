-- Booking operations workspace: tasks, travellers, service reservations and reminders.

alter table public.company_settings add column if not exists timezone text not null default 'Asia/Kolkata';

create table public.operation_task_templates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  title text not null,
  category text not null default 'general',
  anchor text not null default 'arrival' check (anchor in ('confirmation','arrival','departure')),
  offset_days integer not null default 0 check (offset_days between -365 and 365),
  priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  assignment_rule text not null default 'booking_owner' check (assignment_rule in ('booking_owner','unassigned')),
  position integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, company_id)
);
create index operation_templates_company_idx on public.operation_task_templates(company_id, active, position);

create table public.booking_tasks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  booking_id uuid not null,
  template_id uuid references public.operation_task_templates(id) on delete set null,
  title text not null,
  category text not null default 'general',
  status text not null default 'todo' check (status in ('todo','in_progress','blocked','done','cancelled')),
  priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  due_at timestamptz,
  assignee_id uuid references auth.users(id),
  notes text,
  source text not null default 'manual' check (source in ('manual','template','system')),
  completed_by uuid references auth.users(id),
  completed_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, company_id),
  foreign key (booking_id, company_id) references public.bookings(id, company_id) on delete cascade
);
create unique index booking_tasks_template_unique on public.booking_tasks(booking_id, template_id);
create index booking_tasks_due_idx on public.booking_tasks(company_id, status, due_at);
create index booking_tasks_assignee_idx on public.booking_tasks(company_id, assignee_id, status, due_at);

create table public.booking_travellers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  booking_id uuid not null,
  traveller_type text not null default 'adult' check (traveller_type in ('adult','child')),
  full_name text not null,
  date_of_birth date,
  phone text,
  email text,
  is_primary boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, company_id),
  foreign key (booking_id, company_id) references public.bookings(id, company_id) on delete cascade
);
create index booking_travellers_booking_idx on public.booking_travellers(company_id, booking_id);

create table public.booking_traveller_documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  booking_id uuid not null,
  traveller_id uuid not null,
  document_type text not null,
  status text not null default 'uploaded' check (status in ('required','uploaded','verified','rejected','expired')),
  storage_path text,
  original_name text,
  mime_type text,
  size_bytes bigint check (size_bytes is null or size_bytes >= 0),
  expiry_date date,
  notes text,
  verified_by uuid references auth.users(id),
  verified_at timestamptz,
  replaced_by_id uuid references public.booking_traveller_documents(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, company_id),
  foreign key (booking_id, company_id) references public.bookings(id, company_id) on delete cascade,
  foreign key (traveller_id, company_id) references public.booking_travellers(id, company_id) on delete cascade
);
create index traveller_documents_booking_idx on public.booking_traveller_documents(company_id, booking_id, status);

create table public.booking_services (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  booking_id uuid not null,
  type text not null check (type in ('flight','train','activity')),
  title text not null,
  status text not null default 'draft' check (status in ('draft','requested','on_hold','confirmed','ticketed','reconfirmation_required','cancelled')),
  supplier_id uuid,
  supplier_name text,
  supplier_phone text,
  supplier_email text,
  confirmation_reference text,
  booking_deadline timestamptz,
  start_at timestamptz,
  end_at timestamptz,
  origin text,
  destination text,
  cost numeric(12,2) not null default 0 check (cost >= 0),
  currency text not null default 'INR',
  segments jsonb not null default '[]'::jsonb,
  notes text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, company_id),
  foreign key (booking_id, company_id) references public.bookings(id, company_id) on delete cascade
);
create index booking_services_booking_idx on public.booking_services(company_id, booking_id, type, status);

create table public.booking_service_travellers (
  company_id uuid not null references public.companies(id) on delete cascade,
  service_id uuid not null,
  traveller_id uuid not null,
  primary key (service_id, traveller_id),
  foreign key (service_id, company_id) references public.booking_services(id, company_id) on delete cascade,
  foreign key (traveller_id, company_id) references public.booking_travellers(id, company_id) on delete cascade
);

create table public.operation_reminder_rules (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null,
  event text not null check (event in ('arrival','departure','supplier_reconfirm','task_due')),
  recipient text not null check (recipient in ('customer','supplier','staff')),
  channel text not null check (channel in ('email','whatsapp','in_app')),
  offset_hours integer not null default -24 check (offset_hours between -8760 and 8760),
  send_hour integer not null default 10 check (send_hour between 0 and 23),
  subject_template text,
  body_template text not null,
  active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, company_id)
);
create index reminder_rules_company_idx on public.operation_reminder_rules(company_id, active, event);

create table public.user_notifications (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  booking_id uuid,
  task_id uuid,
  type text not null default 'info',
  title text not null,
  body text not null,
  dedupe_key text,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (booking_id, company_id) references public.bookings(id, company_id) on delete cascade,
  foreign key (task_id, company_id) references public.booking_tasks(id, company_id) on delete cascade
);
create unique index user_notifications_dedupe_idx on public.user_notifications(company_id, user_id, dedupe_key);
create index user_notifications_user_idx on public.user_notifications(company_id, user_id, read_at, created_at desc);

alter table public.booking_stays
  add column if not exists supplier_id uuid,
  add column if not exists supplier_phone text,
  add column if not exists supplier_email text,
  add column if not exists confirmation_deadline timestamptz;
alter table public.booking_stays drop constraint if exists booking_stays_confirmation_status_check;
alter table public.booking_stays add constraint booking_stays_confirmation_status_check check (confirmation_status in ('pending','requested','on_hold','confirmed','reconfirmation_required','cancelled'));

alter table public.booking_transport_days
  add column if not exists confirmation_status text not null default 'pending',
  add column if not exists supplier_id uuid,
  add column if not exists supplier_name text,
  add column if not exists supplier_phone text,
  add column if not exists supplier_email text,
  add column if not exists confirmation_reference text,
  add column if not exists driver_status text not null default 'unassigned',
  add column if not exists driver_confirmed_at timestamptz,
  add column if not exists instructions text;
alter table public.booking_transport_days add constraint booking_transport_confirmation_status_check check (confirmation_status in ('pending','requested','on_hold','confirmed','reconfirmation_required','cancelled'));
alter table public.booking_transport_days add constraint booking_transport_driver_status_check check (driver_status in ('unassigned','assigned','confirmed','completed','cancelled'));

alter table public.messages
  add column if not exists booking_id uuid,
  add column if not exists task_id uuid,
  add column if not exists kind text,
  add column if not exists subject text,
  add column if not exists body text,
  add column if not exists scheduled_for timestamptz,
  add column if not exists next_attempt_at timestamptz,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists updated_at timestamptz not null default now();
alter table public.messages add constraint messages_booking_fk foreign key (booking_id, company_id) references public.bookings(id, company_id) on delete cascade;
alter table public.messages add constraint messages_task_fk foreign key (task_id, company_id) references public.booking_tasks(id, company_id) on delete cascade;
alter table public.messages drop constraint if exists messages_one_target;
alter table public.messages add constraint messages_one_target check (
  (quote_id is not null)::integer + (record_id is not null)::integer + (booking_document_id is not null)::integer +
  (booking_id is not null)::integer + (task_id is not null)::integer = 1
);
create index messages_due_idx on public.messages(status, next_attempt_at, scheduled_for) where status in ('queued','retry');
create unique index messages_booking_kind_unique on public.messages(company_id, booking_id, kind);

alter table public.operation_task_templates enable row level security;
alter table public.booking_tasks enable row level security;
alter table public.booking_travellers enable row level security;
alter table public.booking_traveller_documents enable row level security;
alter table public.booking_services enable row level security;
alter table public.booking_service_travellers enable row level security;
alter table public.operation_reminder_rules enable row level security;
alter table public.user_notifications enable row level security;

create policy operation_templates_read on public.operation_task_templates for select to authenticated using (public.can_access(company_id, 'booking_operations.read'));
create policy operation_templates_write on public.operation_task_templates for all to authenticated using (public.can_access(company_id, 'operation_settings.write')) with check (public.can_access(company_id, 'operation_settings.write'));
create policy booking_tasks_read on public.booking_tasks for select to authenticated using (public.can_access(company_id, 'booking_operations.read'));
create policy booking_tasks_write on public.booking_tasks for all to authenticated using (public.can_access(company_id, 'booking_operations.write') or public.can_access(company_id, 'booking_tasks.assign')) with check (public.can_access(company_id, 'booking_operations.write') or public.can_access(company_id, 'booking_tasks.assign'));
create policy booking_travellers_read on public.booking_travellers for select to authenticated using (public.can_access(company_id, 'booking_operations.read'));
create policy booking_travellers_write on public.booking_travellers for all to authenticated using (public.can_access(company_id, 'booking_operations.write')) with check (public.can_access(company_id, 'booking_operations.write'));
create policy traveller_documents_read on public.booking_traveller_documents for select to authenticated using (public.can_access(company_id, 'traveller_documents.read'));
create policy traveller_documents_write on public.booking_traveller_documents for all to authenticated using (public.can_access(company_id, 'traveller_documents.write') or public.can_access(company_id, 'traveller_documents.verify')) with check (public.can_access(company_id, 'traveller_documents.write') or public.can_access(company_id, 'traveller_documents.verify'));
create policy booking_services_read on public.booking_services for select to authenticated using (public.can_access(company_id, 'booking_operations.read'));
create policy booking_services_write on public.booking_services for all to authenticated using (public.can_access(company_id, 'booking_operations.write')) with check (public.can_access(company_id, 'booking_operations.write'));
create policy service_travellers_read on public.booking_service_travellers for select to authenticated using (public.can_access(company_id, 'booking_operations.read'));
create policy service_travellers_write on public.booking_service_travellers for all to authenticated using (public.can_access(company_id, 'booking_operations.write')) with check (public.can_access(company_id, 'booking_operations.write'));
create policy reminder_rules_read on public.operation_reminder_rules for select to authenticated using (public.can_access(company_id, 'booking_operations.read'));
create policy reminder_rules_write on public.operation_reminder_rules for all to authenticated using (public.can_access(company_id, 'operation_settings.write')) with check (public.can_access(company_id, 'operation_settings.write'));
create policy notifications_read on public.user_notifications for select to authenticated using (user_id = auth.uid() and public.can_access(company_id, 'notifications.read'));
create policy notifications_update on public.user_notifications for update to authenticated using (user_id = auth.uid() and public.can_access(company_id, 'notifications.read')) with check (user_id = auth.uid() and public.can_access(company_id, 'notifications.read'));

create or replace function public.seed_operation_defaults(p_company_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.operation_task_templates where company_id = p_company_id) then return; end if;
  insert into public.operation_task_templates(company_id,title,category,anchor,offset_days,priority,position) values
    (p_company_id,'Confirm traveller names and contacts','travellers','confirmation',0,'high',10),
    (p_company_id,'Collect required traveller documents','documents','arrival',-21,'high',20),
    (p_company_id,'Verify traveller documents','documents','arrival',-14,'high',30),
    (p_company_id,'Confirm hotel stays','suppliers','arrival',-14,'high',40),
    (p_company_id,'Confirm flight, train and activities','reservations','arrival',-14,'high',50),
    (p_company_id,'Collect outstanding payment','finance','arrival',-7,'urgent',60),
    (p_company_id,'Reconfirm every supplier','suppliers','arrival',-3,'urgent',70),
    (p_company_id,'Assign driver and vehicle','transport','arrival',-2,'urgent',80),
    (p_company_id,'Issue travel vouchers','documents','arrival',-2,'high',90),
    (p_company_id,'Share arrival and driver details','customer','arrival',-1,'urgent',100),
    (p_company_id,'Verify departure transfer','transport','departure',-1,'high',110),
    (p_company_id,'Close trip and complete reconciliation','finance','departure',1,'normal',120);
  insert into public.operation_reminder_rules(company_id,name,event,recipient,channel,offset_hours,send_hour,subject_template,body_template,active) values
    (p_company_id,'Arrival reminder','arrival','customer','whatsapp',-24,10,'Your trip starts tomorrow','Hello {{name}}, your {{destination}} trip starts on {{arrival_date}}. Your travel team is ready to assist.',false),
    (p_company_id,'Departure reminder','departure','customer','whatsapp',-24,10,'Departure reminder','Hello {{name}}, this is a reminder for your departure on {{departure_date}}. Please contact us if you need help.',false),
    (p_company_id,'Supplier reconfirmation','supplier_reconfirm','supplier','email',-72,10,'Please reconfirm {{booking_number}}','Please reconfirm the services for {{name}}, arriving {{arrival_date}}. Reply with the confirmation reference.',false);
end;
$$;
revoke all on function public.seed_operation_defaults(uuid) from public, anon, authenticated;
grant execute on function public.seed_operation_defaults(uuid) to service_role;

do $$ declare row record; begin for row in select id from public.companies loop perform public.seed_operation_defaults(row.id); end loop; end $$;

create or replace function public.seed_operation_defaults_on_company() returns trigger language plpgsql security definer set search_path = public as $$
begin perform public.seed_operation_defaults(new.id); return new; end; $$;
create trigger companies_operation_defaults after insert on public.companies for each row execute function public.seed_operation_defaults_on_company();

update public.roles set permissions = array(
  select distinct permission from unnest(permissions || array['booking_operations.read','booking_operations.write','booking_tasks.assign','notifications.read']) permission
) where '*' <> all(permissions) and 'bookings.write' = any(permissions);

update public.roles set permissions = array(
  select distinct permission from unnest(permissions || array['booking_operations.read','notifications.read']) permission
) where '*' <> all(permissions) and 'bookings.read' = any(permissions);

update public.roles set permissions = array(
  select distinct permission from unnest(permissions || array['traveller_documents.read','traveller_documents.write','traveller_documents.verify']) permission
) where '*' <> all(permissions) and 'files.write' = any(permissions);
