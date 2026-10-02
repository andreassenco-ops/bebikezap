-- Agente autossuficiente: tudo o que precisa para rodar fica nele.
-- Global (ai_configs) passa a ser só a conexão: provedor + chaves.

ALTER TABLE ai_agents
  ADD COLUMN IF NOT EXISTS welcome_message text,      -- enviada quando o fluxo transfere
  ADD COLUMN IF NOT EXISTS handoff_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL; -- null = fila

UPDATE ai_agents SET model = 'claude-haiku-4-5-20251001' WHERE model IS NULL;
ALTER TABLE ai_agents
  ALTER COLUMN model SET DEFAULT 'claude-haiku-4-5-20251001',
  ALTER COLUMN model SET NOT NULL;

-- Agente consulta só os próprios documentos (menos tokens, sem mistura).
-- p_agent_id null = todos (rascunho do atendente no inbox).
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
    AND (p_agent_id IS NULL OR d.agent_id = p_agent_id)
  ORDER BY rank DESC
  LIMIT GREATEST(p_match_count, 0);
$$ LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public;

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
    AND (p_agent_id IS NULL OR d.agent_id = p_agent_id)
  ORDER BY c.embedding <=> p_query_embedding::vector(1536)
  LIMIT GREATEST(p_match_count, 0);
$$ LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public;
