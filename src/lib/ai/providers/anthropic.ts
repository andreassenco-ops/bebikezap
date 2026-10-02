import { AiError, type ChatMessage, type ProviderResult } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared'

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

interface AnthropicResponse {
  content?: { type?: string; text?: string }[]
  usage?: { input_tokens?: number; output_tokens?: number }
}

/**
 * Anthropic's Messages API requires strictly alternating roles that
 * begin with `user`. Merge consecutive turns; when the transcript opens
 * with the business (menu, agent greeting), put a placeholder customer
 * turn first so that context is kept instead of dropped. Guarantees a
 * valid, non-empty payload.
 */
function normalizeForAnthropic(messages: ChatMessage[]): ChatMessage[] {
  const merged = mergeConsecutive(messages)
  if (merged.length === 0) {
    return [{ role: 'user', content: '(The customer has not sent a message yet.)' }]
  }
  if (merged[0].role === 'assistant') {
    merged.unshift({ role: 'user', content: '(Conversation start.)' })
  }
  return merged
}

type CacheControl = { cache_control?: { type: 'ephemeral' } }
type Block =
  | ({ type: 'text'; text: string } & CacheControl)
  | ({
      type: 'image' | 'document'
      source: { type: 'base64'; media_type: string; data: string }
    } & CacheControl)

/** Anthropic rejects base64 images above 5 MB (PDFs may be larger). */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

/**
 * Message → content blocks, with any images / PDFs downloaded and inlined
 * as base64. A file that can't be fetched becomes a text note instead of
 * failing the whole reply.
 * ponytail: media is re-downloaded every turn; cache it if storage egress matters.
 */
async function toBlocks(m: ChatMessage): Promise<Block[]> {
  const blocks: Block[] = []
  for (const media of m.media ?? []) {
    const isPdf = media.mimeType === 'application/pdf'
    try {
      const res = await fetch(media.url, { signal: AbortSignal.timeout(15_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const bytes = Buffer.from(await res.arrayBuffer())
      if (!isPdf && bytes.length > MAX_IMAGE_BYTES) {
        blocks.push({ type: 'text', text: '[imagem grande demais para abrir — peça para enviar como foto]' })
        continue
      }
      blocks.push({
        type: isPdf ? 'document' : 'image',
        source: { type: 'base64', media_type: media.mimeType, data: bytes.toString('base64') },
      })
    } catch (err) {
      console.warn('[ai anthropic] media fetch failed:', err instanceof Error ? err.message : err)
      blocks.push({ type: 'text', text: '[arquivo indisponível]' })
    }
  }
  blocks.push({ type: 'text', text: m.content })
  return blocks
}

/**
 * Call Anthropic's Messages endpoint with the caller's own key.
 * Returns the raw assistant text + token usage (handoff parsing happens
 * in `generateReply`).
 */
export async function generateAnthropic(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs } = args

  const payload = await Promise.all(
    normalizeForAnthropic(messages).map(async (m) => ({ role: m.role, content: await toBlocks(m) })),
  )
  // Prompt caching: the system prompt and the transcript so far are reused
  // on the next turn at a fraction of the input price (ignored when too short).
  const lastBlocks = payload[payload.length - 1].content
  lastBlocks[lastBlocks.length - 1].cache_control = { type: 'ephemeral' }

  let res: Response
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: payload,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('Anthropic', res)
  }

  const data = (await res.json().catch(() => null)) as AnthropicResponse | null
  const text = data?.content
    ?.filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim()
  if (!text) {
    throw new AiError('Anthropic returned an empty response.', {
      code: 'empty_response',
    })
  }
  // Anthropic reports input/output but no total — normalizeUsage sums.
  const usage = normalizeUsage({
    prompt: data?.usage?.input_tokens,
    completion: data?.usage?.output_tokens,
  })
  return { text, usage }
}
