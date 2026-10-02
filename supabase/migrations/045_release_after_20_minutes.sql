-- 045 — devolução para o pool "Aguardando atendimento" passa de 10 para 20 minutos
-- sem resposta do atendente (decisão do laboratório). Idempotente.
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'release-stale-assignments';
SELECT cron.schedule('release-stale-assignments', '* * * * *', $$SELECT public.release_stale_assignments(20)$$);
