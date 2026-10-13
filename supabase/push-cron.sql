-- Optional: sends rest-timer alerts every 10 seconds, so a rest longer than the 2 minutes the
-- app's own call can wait for (supabase-push.js WAIT_MAX_SEC) still rings with the app closed.
-- Needs the pg_cron (with seconds support) and pg_net extensions, and the function deployed
-- (supabase/functions/send-due-pushes). Run once in the SQL editor after replacing the two
-- placeholders. The service role key stays in the database (Vault), never in the app.
--
--   select vault.create_secret('<SERVICE_ROLE_KEY>', 'service_role_key');
--
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('send-due-pushes') where exists (select 1 from cron.job where jobname = 'send-due-pushes');
select cron.schedule('send-due-pushes', '10 seconds', $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/send-due-pushes',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')),
    body := '{}'::jsonb);
$$);
