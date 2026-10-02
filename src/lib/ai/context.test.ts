import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildConversationContext } from './context'

/** Minimal fake matching the query chain in buildConversationContext:
 *  from().select().eq().eq().order().limit() → { data, error }. */
function fakeDb(rows: unknown[]): SupabaseClient {
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    in: () => chain,
    order: () => chain,
    limit: () => Promise.resolve({ data: rows, error: null }),
  }
  return chain as unknown as SupabaseClient
}

describe('buildConversationContext — agent media', () => {
  it('attaches images/PDFs and labels media it cannot read', async () => {
    const rows = [
      { sender_type: 'customer', content_text: null, content_type: 'audio', media_url: 'https://x/a.ogg', media_type: 'audio/ogg; codecs=opus' },
      { sender_type: 'customer', content_text: null, content_type: 'document', media_url: 'https://x/p.pdf', media_type: 'application/pdf' },
      { sender_type: 'customer', content_text: 'pedido', content_type: 'image', media_url: 'https://x/i.jpg', media_type: 'image/jpeg' },
      { sender_type: 'bot', content_text: 'Pré-Cadastro', content_type: 'interactive', media_url: null, media_type: null },
    ]
    const out = await buildConversationContext(fakeDb(rows), 'conv-1', 50, { media: true })
    expect(out).toEqual([
      { role: 'assistant', content: 'Pré-Cadastro' },
      { role: 'user', content: 'pedido', media: [{ url: 'https://x/i.jpg', mimeType: 'image/jpeg' }] },
      { role: 'user', content: '[PDF]', media: [{ url: 'https://x/p.pdf', mimeType: 'application/pdf' }] },
      { role: 'user', content: '[áudio que você não consegue abrir]' },
    ])
  })
})

describe('buildConversationContext', () => {
  it('maps sender_type to role and returns chronological order', async () => {
    // DB returns newest-first (created_at DESC); the fn reverses it.
    const rows = [
      { sender_type: 'customer', content_text: 'third' },
      { sender_type: 'agent', content_text: 'second' },
      { sender_type: 'customer', content_text: 'first' },
    ]
    const out = await buildConversationContext(fakeDb(rows), 'conv-1')
    expect(out).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ])
  })

  it('treats bot messages as assistant', async () => {
    const out = await buildConversationContext(
      fakeDb([{ sender_type: 'bot', content_text: 'auto reply' }]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'assistant', content: 'auto reply' }])
  })

  it('drops empty / whitespace-only messages', async () => {
    const out = await buildConversationContext(
      fakeDb([
        { sender_type: 'customer', content_text: '   ' },
        { sender_type: 'customer', content_text: null },
        { sender_type: 'customer', content_text: 'real' },
      ]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'user', content: 'real' }])
  })
})
