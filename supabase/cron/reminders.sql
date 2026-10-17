-- Run after migration 0006 and after adding the same CRON_SECRET to Render.
-- Replace the two values once, run the vault statements, then run the schedule block.
-- select vault.create_secret('https://travcrm-api.onrender.com', 'travcrm_api_url');
-- select vault.create_secret('YOUR_RENDER_CRON_SECRET', 'travcrm_cron_secret');

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

select cron.unschedule(jobid) from cron.job where jobname = 'travcrm-booking-reminders';
select cron.schedule(
  'travcrm-booking-reminders',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'travcrm_api_url') || '/api/v1/internal/jobs/reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'travcrm_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
