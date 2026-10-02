import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'

interface DbMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  content_text: string | null
  content_type?: string
  media_url?: string | null
  media_type?: string | null
}

/** Media the model can read (Anthropic vision + PDF). */
const READABLE_MEDIA = /^(image\/(jpeg|png|gif|webp)|application\/pdf)\b/
const AGENT_CONTENT_TYPES = ['text', 'interactive', 'image', 'document', 'audio', 'video']

/**
 * Fetch the last N text messages of a conversation and map them to the
 * provider-neutral chat shape. Customer messages become `user`; agent
 * and bot messages become `assistant`. Non-text messages (media,
 * templates, interactive) are excluded — they carry no text to model —
 * unless `opts.media` is set (specialist agents): then menu taps count as
 * text, images and PDFs ride along as `media`, and other media (audio,
 * video) become a short placeholder so the agent knows something arrived.
 *
 * Ordered oldest-first (chronological) so the transcript reads
 * naturally and the most recent customer message lands last.
 */
export async function buildConversationContext(
  db: SupabaseClient,
  conversationId: string,
  limit: number = aiContextMessageLimit(),
  opts: { media?: boolean } = {},
): Promise<ChatMessage[]> {
  const base = db
    .from('messages')
    .select(
      opts.media
        ? 'sender_type, content_text, content_type, media_url, media_type'
        : 'sender_type, content_text',
    )
    .eq('conversation_id', conversationId)
  const { data, error } = await (opts.media
    ? base.in('content_type', AGENT_CONTENT_TYPES)
    : base.eq('content_type', 'text'))
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  const rows = ((data ?? []) as unknown as DbMessage[]).reverse()
  const out: ChatMessage[] = []
  for (const m of rows) {
    const role = m.sender_type === 'customer' ? 'user' : 'assistant'
    const text = m.content_text?.trim() ?? ''
    if (!opts.media || !m.media_url) {
      if (text) out.push({ role, content: text })
      continue
    }
    const mimeType = (m.media_type ?? '').split(';')[0].trim()
    if (READABLE_MEDIA.test(mimeType)) {
      out.push({
        role,
        content: text || (mimeType === 'application/pdf' ? '[PDF]' : '[imagem]'),
        media: [{ url: m.media_url, mimeType }],
      })
    } else {
      const kind =
        m.content_type === 'audio' ? 'áudio' : m.content_type === 'video' ? 'vídeo' : 'arquivo'
      out.push({ role, content: `${text ? `${text}\n` : ''}[${kind} que você não consegue abrir]` })
    }
  }
  return out
}
