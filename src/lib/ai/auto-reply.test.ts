import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AiConfig } from './types'

// Shared, hoisted mock state so the module mocks can close over it.
const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateReply: vi.fn(),
  engineSendText: vi.fn(),
  loadAccountMetaCredentials: vi.fn(),
  sendTypingIndicator: vi.fn(),
  state: {
    conv: null as Record<string, unknown> | null,
    agent: null as Record<string, unknown> | null,
    autoResponders: [] as { id: string }[],
    claim: true as boolean,
    updatePayload: null as Record<string, unknown> | null,
    rpcCalls: [] as { name: string; args: unknown }[],
  },
}))

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./context', () => ({ buildConversationContext: h.buildConversationContext }))
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))
vi.mock('@/lib/flows/meta-send', () => ({
  engineSendText: h.engineSendText,
  loadAccountMetaCredentials: h.loadAccountMetaCredentials,
}))
vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTypingIndicator: h.sendTypingIndicator,
}))
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'automations') {
        // .select().eq().eq().in().limit() → active auto-responders
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          limit: () =>
            Promise.resolve({ data: h.state.autoResponders, error: null }),
        }
        return chain
      }
      if (table === 'ai_agents') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({ data: h.state.agent, error: null }),
            }),
          }),
        }
      }
      // conversations
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: h.state.conv, error: null }),
          }),
        }),
        update: (payload: Record<string, unknown>) => {
          h.state.updatePayload = payload
          return { eq: () => Promise.resolve({ error: null }) }
        },
      }
    },
    rpc: (name: string, args: unknown) => {
      h.state.rpcCalls.push({ name, args })
      return Promise.resolve({ data: h.state.claim, error: null })
    },
  }),
}))

import { dispatchInboundToAiReply } from './auto-reply'

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
  inboundMessageId: 'wamid.inbound-1',
}

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    ...overrides,
  }
}

beforeEach(() => {
  h.state.conv = {
    assigned_agent_id: null,
    ai_autoreply_disabled: false,
    ai_reply_count: 0,
  }
  h.state.agent = null
  h.state.autoResponders = []
  h.state.claim = true
  h.state.updatePayload = null
  h.state.rpcCalls = []
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hi' }])
  h.retrieveKnowledge.mockResolvedValue([])
  h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false })
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' })
  h.loadAccountMetaCredentials.mockResolvedValue({
    phoneNumberId: 'pn-1',
    accessToken: 'tok',
  })
  h.sendTypingIndicator.mockResolvedValue(undefined)
})

describe('dispatchInboundToAiReply — eligibility gates', () => {
  it('claims a slot and sends on the happy path', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toEqual([
      {
        name: 'claim_ai_reply_slot',
        args: { conversation_id: 'conv-1', max_replies: 3 },
      },
    ])
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
  })

  it('grounds the reply in retrieved knowledge', async () => {
    h.retrieveKnowledge.mockResolvedValue(['Returns accepted within 30 days.'])
    await dispatchInboundToAiReply(ARGS)
    expect(h.retrieveKnowledge).toHaveBeenCalled()
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('Returns accepted within 30 days.')
  })

  it('stands down when an active message-level automation exists', async () => {
    h.state.autoResponders = [{ id: 'auto-1' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
  })

  it('does not send when the atomic slot claim loses the race', async () => {
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    // It still attempts the claim, but the send is skipped.
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when AI is off / not configured', async () => {
    h.loadAiConfig.mockResolvedValue(null)
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply is disabled for the account', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when a human agent is assigned', async () => {
    h.state.conv = {
      assigned_agent_id: 'agent-9',
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
  })

  it('skips when auto-reply was disabled on this conversation', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: true,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when the per-conversation cap is reached', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when there is nothing to reply to', async () => {
    h.buildConversationContext.mockResolvedValue([])
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — typing indicator (#527)', () => {
  it('shows "typing…" on the inbound wamid before calling the LLM', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.loadAccountMetaCredentials).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
    )
    expect(h.sendTypingIndicator).toHaveBeenCalledTimes(1)
    expect(h.sendTypingIndicator).toHaveBeenCalledWith({
      phoneNumberId: 'pn-1',
      accessToken: 'tok',
      messageId: 'wamid.inbound-1',
    })
    // Ordering: the indicator goes out while the customer waits on the
    // model, not after the reply is already generated.
    const typingOrder = h.sendTypingIndicator.mock.invocationCallOrder[0]
    const llmOrder = h.generateReply.mock.invocationCallOrder[0]
    expect(typingOrder).toBeLessThan(llmOrder)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })

  it('still sends the reply when the indicator request fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.sendTypingIndicator.mockRejectedValue(new Error('Meta API error: 400'))
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).toHaveBeenCalledTimes(1)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('typing indicator failed'),
      expect.any(Error),
    )
    warn.mockRestore()
  })

  it('still sends the reply when the WhatsApp credentials cannot be loaded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.loadAccountMetaCredentials.mockRejectedValue(
      new Error('WhatsApp not configured for this account'),
    )
    await dispatchInboundToAiReply(ARGS)
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('skips the indicator when no inbound wamid is supplied', async () => {
    const { inboundMessageId: _omit, ...legacyArgs } = ARGS
    void _omit
    await dispatchInboundToAiReply(legacyArgs)
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
    expect(h.loadAccountMetaCredentials).not.toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })

  it('does not fire when a gate short-circuits before the LLM', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.sendTypingIndicator).not.toHaveBeenCalled()
    expect(h.loadAccountMetaCredentials).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — handoff', () => {
  it('disables auto-reply, writes a summary, and does not send on handoff', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain(
      'AI agent handed off',
    )
    // No handoff target configured → conversation left unassigned.
    expect(h.state.updatePayload).not.toHaveProperty('assigned_agent_id')
  })

  it('routes to the configured handoff agent on handoff', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      assigned_agent_id: 'agent-7',
    })
  })
})

describe('dispatchInboundToAiReply — media without an agent', () => {
  it('ignores a photo when no specialist agent owns the thread', async () => {
    await dispatchInboundToAiReply({ ...ARGS, mediaOnly: true })
    expect(h.generateReply).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — specialist agent', () => {
  beforeEach(() => {
    h.state.conv = { ...h.state.conv, ai_agent_id: 'ag-1' }
    h.state.agent = { id: 'ag-1', system_prompt: 'Faça orçamentos.', model: 'claude-x', max_replies: 5, is_active: true }
    // Agents answer even with the account-wide auto-reply off.
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false, systemPrompt: 'GLOBAL CONTEXT' }))
  })

  it('uses the agent prompt, model, cap and knowledge filter', async () => {
    await dispatchInboundToAiReply(ARGS)
    const call = h.generateReply.mock.calls[0][0]
    expect(call.systemPrompt).toContain('Faça orçamentos.')
    expect(call.config.model).toBe('claude-x')
    // Self-contained: nothing from the account-wide prompt leaks in.
    expect(call.systemPrompt).not.toContain('GLOBAL CONTEXT')
    expect(h.retrieveKnowledge.mock.calls[0][5]).toBe('ag-1')
    expect(h.state.rpcCalls[0].args).toEqual({ conversation_id: 'conv-1', max_replies: 5 })
    expect(h.engineSendText).toHaveBeenCalled()
  })

  it('sends the farewell and closes on [[ENCERRAR]]', async () => {
    h.generateReply.mockResolvedValue({ text: 'Até logo! [[ENCERRAR]]', handoff: false })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(expect.objectContaining({ text: 'Até logo!' }))
    expect(h.state.updatePayload).toMatchObject({ status: 'closed' })
  })

  it('sends the customer part and hands the [[REGISTRO]] record to the team', async () => {
    h.generateReply.mockResolvedValue({
      text: 'Pronto, Maria! [[REGISTRO]] {"status":"pronto_para_revisao"}',
      handoff: false,
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    expect(h.engineSendText).toHaveBeenCalledWith(expect.objectContaining({ text: 'Pronto, Maria!' }))
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain('"status": "pronto_para_revisao"')
  })

  it('reads media with a longer context window', async () => {
    await dispatchInboundToAiReply({ ...ARGS, mediaOnly: true })
    expect(h.buildConversationContext).toHaveBeenCalledWith(expect.anything(), 'conv-1', 50, { media: true })
    expect(h.generateReply).toHaveBeenCalled()
  })

  it('sends the transfer note, then hands off', async () => {
    h.generateReply.mockResolvedValue({ text: 'Vou te transferir.', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledWith(expect.objectContaining({ text: 'Vou te transferir.' }))
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
  })

  it('hands off without calling the LLM when the agent is disabled or at its cap', async () => {
    h.state.agent = { ...h.state.agent, is_active: false }
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })

    h.state.updatePayload = null
    h.state.agent = { ...h.state.agent, is_active: true }
    h.state.conv = { ...h.state.conv, ai_reply_count: 5 }
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.generateReply).not.toHaveBeenCalled()
  })
})
