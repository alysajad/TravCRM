alter table public.company_settings
  add column if not exists document_cover_path text;

alter table public.company_settings
  drop constraint if exists company_settings_document_template_check;

alter table public.company_settings
  add constraint company_settings_document_template_check
  check (document_template in ('elegant','modern','compact','journey','expedition','brochure'));
