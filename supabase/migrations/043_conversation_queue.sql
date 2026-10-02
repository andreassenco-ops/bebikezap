-- ============================================================
-- 043_conversation_queue.sql — fila única de atendimento ("Pegar próximo")
--
-- Modelo (decidido com o laboratório):
--   - Toda conversa não atribuída, não fechada, sem URA em andamento e
--     com mensagem do cliente sem resposta de atendente fica na FILA.
--   - Ordem = há quanto tempo o cliente espera (primeira mensagem sem
--     resposta), então quem espera mais é atendido primeiro.
--   - O atendente só recebe conversa pelo botão "Pegar próximo"
--     (take_next_conversation); não escolhe.
--   - Se o cliente está esperando há mais de 10 min numa conversa
--     atribuída (contando a partir da atribuição), ela volta para a fila
--     — e volta no topo, porque a espera continua contando
--     (release_stale_assignments, via pg_cron a cada minuto).
--
-- Idempotente.
-- ============================================================

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_messages_conversation_sender_created
  ON messages(conversation_id, sender_type, created_at);

-- Desde quando o cliente espera resposta humana (NULL = nada pendente).
CREATE OR REPLACE FUNCTION public.conversation_waiting_since(p_conversation_id UUID)
RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT min(m.created_at)
  FROM messages m
  WHERE m.conversation_id = p_conversation_id
    AND m.sender_type = 'customer'
    AND m.created_at > COALESCE(
      (SELECT max(a.created_at) FROM messages a
        WHERE a.conversation_id = p_conversation_id AND a.sender_type = 'agent'),
      '-infinity'::timestamptz)
$$;

-- ponytail: calcula a espera por conversa a cada chamada; ok para centenas de
-- conversas abertas. Se crescer muito, materializar waiting_since na tabela.
CREATE OR REPLACE VIEW public.conversation_queue
WITH (security_invoker = true) AS
SELECT c.id, c.account_id, c.contact_id, w.waiting_since
FROM conversations c
CROSS JOIN LATERAL (SELECT public.conversation_waiting_since(c.id) AS waiting_since) w
WHERE c.assigned_agent_id IS NULL
  AND c.status <> 'closed'
  AND w.waiting_since IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM flow_runs r WHERE r.conversation_id = c.id AND r.status = 'active'
  );

-- Resumo da fila da conta de quem chama: quantas aguardam e desde quando a mais antiga.
CREATE OR REPLACE FUNCTION public.queue_stats()
RETURNS TABLE (waiting INTEGER, oldest_waiting_since TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(*)::int, min(q.waiting_since)
  FROM conversation_queue q
  WHERE q.account_id = (SELECT account_id FROM profiles WHERE user_id = auth.uid())
$$;

-- Atribui ao chamador a conversa que espera há mais tempo. Retorna o id (ou NULL se a fila está vazia).
-- SKIP LOCKED evita que dois atendentes peguem a mesma conversa ao mesmo tempo.
CREATE OR REPLACE FUNCTION public.take_next_conversation()
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account_id UUID;
  v_role account_role_enum;
  v_id UUID;
BEGIN
  SELECT account_id, account_role INTO v_account_id, v_role FROM profiles WHERE user_id = auth.uid();
  IF v_account_id IS NULL OR v_role = 'viewer' THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;

  SELECT c.id INTO v_id
  FROM conversations c
  JOIN conversation_queue q ON q.id = c.id
  WHERE c.account_id = v_account_id
  ORDER BY q.waiting_since
  LIMIT 1
  FOR UPDATE OF c SKIP LOCKED;

  IF v_id IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE conversations
  SET assigned_agent_id = auth.uid(), assigned_at = now(), status = 'open', updated_at = now()
  WHERE id = v_id;
  RETURN v_id;
END;
$$;

-- Devolve à fila conversas atribuídas em que o cliente espera há mais de p_minutes
-- (contando a partir da atribuição). Retorna quantas foram devolvidas.
CREATE OR REPLACE FUNCTION public.release_stale_assignments(p_minutes INTEGER DEFAULT 10)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE conversations c
  SET assigned_agent_id = NULL, assigned_at = NULL, updated_at = now()
  FROM (
    SELECT id, public.conversation_waiting_since(id) AS waiting_since
    FROM conversations
    WHERE assigned_agent_id IS NOT NULL AND status <> 'closed'
  ) w
  WHERE c.id = w.id
    AND w.waiting_since IS NOT NULL -- só devolve se o cliente está de fato esperando
    AND GREATEST(w.waiting_since, COALESCE(c.assigned_at, '-infinity'::timestamptz))
        < now() - make_interval(mins => p_minutes);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.queue_stats() TO authenticated;
GRANT EXECUTE ON FUNCTION public.take_next_conversation() TO authenticated;
REVOKE EXECUTE ON FUNCTION public.release_stale_assignments(INTEGER) FROM PUBLIC, anon, authenticated;

-- Roda a devolução a cada minuto dentro do próprio banco (sem depender do servidor do CRM).
CREATE EXTENSION IF NOT EXISTS pg_cron;
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'release-stale-assignments';
SELECT cron.schedule('release-stale-assignments', '* * * * *', $$SELECT public.release_stale_assignments(10)$$);
