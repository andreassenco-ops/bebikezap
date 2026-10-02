-- ============================================================
-- 044_cron_pings.sql — o próprio banco chama os crons do CRM a cada minuto
--
-- /api/automations/cron (esperas das automações) e /api/flows/cron
-- (tempo limite dos fluxos) precisam de um "ping" periódico com o header
-- x-cron-secret. Em vez de um agendador externo, o pg_cron chama via
-- pg_net. URL e segredo ficam na tabela app_cron_config (RLS sem
-- políticas = só service role lê/grava), preenchida no deploy
-- (scripts/deploy-fly.sh). Vazia, a função não faz nada.
-- Idempotente.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE TABLE IF NOT EXISTS public.app_cron_config (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id), -- linha única
  app_url TEXT NOT NULL,
  cron_secret TEXT NOT NULL
);
ALTER TABLE public.app_cron_config ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.ping_app_crons()
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cfg app_cron_config;
BEGIN
  SELECT * INTO cfg FROM app_cron_config WHERE id;
  IF cfg IS NULL THEN
    RETURN;
  END IF;
  PERFORM net.http_get(url := cfg.app_url || '/api/automations/cron', headers := jsonb_build_object('x-cron-secret', cfg.cron_secret));
  PERFORM net.http_get(url := cfg.app_url || '/api/flows/cron', headers := jsonb_build_object('x-cron-secret', cfg.cron_secret));
END;
$$;

REVOKE EXECUTE ON FUNCTION public.ping_app_crons() FROM PUBLIC, anon, authenticated;

SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'ping-app-crons';
SELECT cron.schedule('ping-app-crons', '* * * * *', $$SELECT public.ping_app_crons()$$);
