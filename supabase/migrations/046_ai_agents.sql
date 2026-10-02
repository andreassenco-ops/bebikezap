-- Agentes de IA especialistas. Cada agente tem instruções próprias,
-- modelo opcional e limite de respostas; usa a chave/provedor de ai_configs.
-- Um fluxo entrega a conversa a um agente pelo nó "Transferir"
-- (config.ai_agent_id); o agente responde até encerrar ou passar para humano.

CREATE TABLE IF NOT EXISTS ai_agents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name          text NOT NULL,
  description   text,
  system_prompt text NOT NULL DEFAULT '',
  model         text,                         -- null = modelo de ai_configs
  max_replies   integer NOT NULL DEFAULT 20 CHECK (max_replies BETWEEN 1 AND 100),
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_agents_account_id_idx ON ai_agents (account_id);

ALTER TABLE ai_agents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_agents_select ON ai_agents;
CREATE POLICY ai_agents_select ON ai_agents FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS ai_agents_insert ON ai_agents;
CREATE POLICY ai_agents_insert ON ai_agents FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS ai_agents_update ON ai_agents;
CREATE POLICY ai_agents_update ON ai_agents FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS ai_agents_delete ON ai_agents;
CREATE POLICY ai_agents_delete ON ai_agents FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- Documento da base com agent_id = só aquele agente; null = todos.
ALTER TABLE ai_knowledge_documents
  ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES ai_agents(id) ON DELETE CASCADE;

-- Agente que está atendendo a conversa (null = nenhum).
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_agent_id uuid REFERENCES ai_agents(id) ON DELETE SET NULL;

-- Busca na base filtrada por agente. p_agent_id null = todos os documentos
-- (rascunho do atendente / IA geral); senão, documentos do agente + gerais.
DROP FUNCTION IF EXISTS public.match_ai_knowledge_fts(uuid, text, integer);
CREATE OR REPLACE FUNCTION public.match_ai_knowledge_fts(
  p_account_id  uuid,
  p_query       text,
  p_match_count integer,
  p_agent_id    uuid DEFAULT NULL
)
RETURNS TABLE (id uuid, content text, rank real) AS $$
  SELECT c.id,
         c.content,
         ts_rank(c.fts, plainto_tsquery('simple', p_query)) AS rank
  FROM ai_knowledge_chunks c
  JOIN ai_knowledge_documents d ON d.id = c.document_id
  WHERE c.account_id = p_account_id
    AND c.fts @@ plainto_tsquery('simple', p_query)
    AND (p_agent_id IS NULL OR d.agent_id IS NULL OR d.agent_id = p_agent_id)
  ORDER BY rank DESC
  LIMIT GREATEST(p_match_count, 0);
$$ LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public;

DROP FUNCTION IF EXISTS public.match_ai_knowledge_semantic(uuid, text, integer);
CREATE OR REPLACE FUNCTION public.match_ai_knowledge_semantic(
  p_account_id      uuid,
  p_query_embedding text,
  p_match_count     integer,
  p_agent_id        uuid DEFAULT NULL
)
RETURNS TABLE (id uuid, content text, distance real) AS $$
  SELECT c.id,
         c.content,
         (c.embedding <=> p_query_embedding::vector(1536)) AS distance
  FROM ai_knowledge_chunks c
  JOIN ai_knowledge_documents d ON d.id = c.document_id
  WHERE c.account_id = p_account_id
    AND c.embedding IS NOT NULL
    AND (p_agent_id IS NULL OR d.agent_id IS NULL OR d.agent_id = p_agent_id)
  ORDER BY c.embedding <=> p_query_embedding::vector(1536)
  LIMIT GREATEST(p_match_count, 0);
$$ LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public;

REVOKE ALL ON FUNCTION public.match_ai_knowledge_fts(uuid, text, integer, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_ai_knowledge_fts(uuid, text, integer, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.match_ai_knowledge_semantic(uuid, text, integer, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.match_ai_knowledge_semantic(uuid, text, integer, uuid) TO authenticated, service_role;

-- Conversa com agente de IA ativo é "Automatizado", não entra na fila humana.
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
  )
  AND NOT (c.ai_agent_id IS NOT NULL AND NOT COALESCE(c.ai_autoreply_disabled, false));
