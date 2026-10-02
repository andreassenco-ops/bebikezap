import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadEmbeddingsKey } from '@/lib/ai/config'
import { ingestDocument } from '@/lib/ai/knowledge'
import { AiError } from '@/lib/ai/types'

/**
 * GET /api/ai/knowledge
 *
 * List the account's knowledge-base documents (any member).
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    // ?agent_id=X → that agent's own documents; none → the general base.
    const agentId = new URL(request.url).searchParams.get('agent_id')
    let query = supabase
      .from('ai_knowledge_documents')
      .select('id, title, updated_at')
      .eq('account_id', accountId)
    query = agentId ? query.eq('agent_id', agentId) : query.is('agent_id', null)
    const { data, error } = await query.order('updated_at', { ascending: false })
    if (error) {
      console.error('[ai/knowledge GET] error:', error)
      return NextResponse.json(
        { error: 'Não foi possível carregar a base de conhecimento' },
        { status: 500 },
      )
    }
    return NextResponse.json({ documents: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/ai/knowledge  (admin+)
 *
 * Create a document, then chunk + (optionally) embed it. If indexing
 * fails the document is still saved so the admin can retry via reindex.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-kb:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const title = typeof body?.title === 'string' ? body.title.trim() : ''
    const content = typeof body?.content === 'string' ? body.content.trim() : ''
    const agentId = typeof body?.agent_id === 'string' && body.agent_id ? body.agent_id : null
    if (!title || !content) {
      return NextResponse.json(
        { error: 'Título e conteúdo são obrigatórios' },
        { status: 400 },
      )
    }

    const { data: doc, error } = await supabase
      .from('ai_knowledge_documents')
      .insert({ account_id: accountId, created_by: userId, title, content, agent_id: agentId })
      .select('id')
      .single()
    if (error || !doc) {
      console.error('[ai/knowledge POST] insert error:', error)
      return NextResponse.json(
        { error: 'Não foi possível salvar o documento' },
        { status: 500 },
      )
    }

    const { key: embeddingsApiKey, corrupt } = await loadEmbeddingsKey(
      supabase,
      accountId,
    )
    try {
      await ingestDocument(
        supabase,
        accountId,
        { embeddingsApiKey },
        doc.id,
        content,
      )
    } catch (err) {
      const message = err instanceof AiError ? err.message : 'indexing failed'
      console.error('[ai/knowledge POST] ingest error:', err)
      return NextResponse.json(
        {
          success: true,
          id: doc.id,
          warning: `Salvo, mas a indexação semântica falhou (${message}). A busca por palavras continua funcionando; use Reindexar para tentar de novo.`,
        },
        { status: 200 },
      )
    }

    if (corrupt) {
      return NextResponse.json({
        success: true,
        id: doc.id,
        warning:
          'Saved with keyword search only — your embeddings key could not be decrypted (check ENCRYPTION_KEY, then re-enter the key).',
      })
    }
    return NextResponse.json({ success: true, id: doc.id })
  } catch (err) {
    return toErrorResponse(err)
  }
}
