import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { generateReply } from './generate'
import { buildSystemPrompt } from './defaults'
import {
  agentConfig,
  agentUserPrompt,
  loadAgent,
  recordSummary,
  splitClose,
  splitRecord,
} from './agents'
import { buildHandoffSummary } from './handoff'
import { logAiUsage } from './usage'
import { latestUserMessage } from './query'
import {
  engineSendText,
  loadAccountMetaCredentials,
} from '@/lib/flows/meta-send'
import { sendTypingIndicator } from '@/lib/whatsapp/meta-api'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'

/** Messages an agent sees per turn (text + media). */
const AGENT_CONTEXT_MESSAGES = 50

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
  /** Meta's wamid of the customer message we're replying to. When set,
   *  a typing indicator (which also marks it read) is shown while the
   *  reply is generated. Optional so older callers keep working. */
  inboundMessageId?: string
  /** The inbound carried media but no text (photo, PDF, audio). Only a
   *  specialist agent reacts to those. */
  mediaOnly?: boolean
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 *
 * Eligibility gates (any → silent no-op):
 *   - AI off / auto-reply disabled for the account
 *   - a human agent is assigned (they own the thread)
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - the per-conversation reply cap is reached
 *   - there's nothing to reply to
 *
 * The 24h WhatsApp session window is inherently open here — we're
 * reacting to a customer message that just landed — so no separate
 * window check is needed.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const {
    accountId,
    conversationId,
    contactId,
    configOwnerUserId,
    inboundMessageId,
    mediaOnly,
  } = args

  try {
    const db = supabaseAdmin()

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count, ai_agent_id')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) return
    if (conv.assigned_agent_id) return // a human owns this thread
    if (conv.ai_autoreply_disabled) return // handed off / turned off here

    // Specialist agent set by a flow (Transferir -> agente de IA). It answers
    // even with the account-wide auto-reply off.
    const agent = conv.ai_agent_id
      ? await loadAgent(db, conv.ai_agent_id as string)
      : null
    const config = await loadAiConfig(db, accountId)

    if (conv.ai_agent_id) {
      // Agent gone/disabled or AI switched off: never leave the customer
      // stuck in "Automatizado" - send them to the human queue.
      if (!agent?.is_active || !config) {
        await handOffToHuman(
          db,
          conversationId,
          await buildConversationContext(db, conversationId),
          conv.ai_reply_count ?? 0,
          agent?.handoff_user_id ?? null,
        )
        return
      }
    } else {
      if (!config || !config.autoReplyEnabled || mediaOnly) return

      // Deterministic, user-configured responders win over the LLM — the
      // caller already excludes messages a Flow consumed. Message-level
      // automations (`new_message_received` / `keyword_match`) are
      // dispatched independently for this same inbound and may send their
      // own reply, so if the account has any active one we stand down to
      // avoid double-texting the customer. (Relationship triggers like
      // `first_inbound_message` don't count — they're not per-message
      // auto-responders.)
      const { data: autoResponders } = await db
        .from('automations')
        .select('id')
        .eq('account_id', accountId)
        .eq('is_active', true)
        .in('trigger_type', ['new_message_received', 'keyword_match'])
        .limit(1)
      if (autoResponders && autoResponders.length > 0) return
    }

    const maxReplies = agent ? agent.max_replies : config.autoReplyMaxPerConversation
    // Cheap early-out; the authoritative cap check is the atomic claim
    // below (this read can race a concurrent inbound). An agent at its cap
    // hands off instead of going silent.
    if (conv.ai_reply_count >= maxReplies) {
      if (agent) {
        await handOffToHuman(
          db,
          conversationId,
          await buildConversationContext(db, conversationId),
          conv.ai_reply_count,
          agent.handoff_user_id,
        )
      }
      return
    }

    // Agents see photos/PDFs and a longer window (a pre-registration runs long).
    const messages = agent
      ? await buildConversationContext(db, conversationId, AGENT_CONTEXT_MESSAGES, { media: true })
      : await buildConversationContext(db, conversationId)
    if (messages.length === 0) return

    // Account-wide throttle on the shared BYO key. The per-conversation
    // cap bounds one thread; this bounds a burst across many threads (a
    // marketing blast landing 200 replies at once) so we never run the
    // owner's key past the provider's rate limit. Over the limit → skip
    // the auto-reply; the inbound still sits in the inbox for a human.
    const acctLimit = checkRateLimit(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount,
    )
    if (!acctLimit.success) {
      console.warn(
        `[ai auto-reply] account ${accountId} hit the per-account rate limit — skipping this inbound.`,
      )
      return
    }

    // Every gate has passed — we're committed to attempting a reply, so
    // show the customer "typing…" (and mark their message read) while the
    // retrieval + LLM round trips run. Meta clears the indicator after
    // 25 s or when our reply lands, whichever is first, so there's
    // nothing to undo on the handoff / no-text path. Strictly
    // best-effort: a failed indicator must never cost us the reply.
    if (inboundMessageId) {
      await showTypingIndicator(db, accountId, inboundMessageId)
    }

    // Ground the reply in the account's knowledge base (best-effort).
    const knowledge = await retrieveKnowledge(
      db,
      accountId,
      config,
      latestUserMessage(messages),
      5,
      agent?.id ?? null,
    )

    const systemPrompt = buildSystemPrompt({
      userPrompt: agentUserPrompt(config, agent),
      mode: 'auto_reply',
      knowledge,
      agent: !!agent,
    })

    const genConfig = agentConfig(config, agent)
    const generation = await generateReply({
      config: genConfig,
      systemPrompt,
      messages,
    })
    const { handoff, usage } = generation
    const split = splitClose(generation.text)
    const { text, record } = agent ? splitRecord(split.text) : { text: split.text, record: null }
    const close = !!agent && split.close

    // Record token spend on the account's BYO key. Fire-and-forget so it
    // never adds latency to the customer-facing send: `logAiUsage`
    // swallows its own errors, so the floating promise can't reject.
    // Logged regardless of handoff — the provider call happened either
    // way.
    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: genConfig.provider,
      model: genConfig.model,
      usage,
    })

    if (handoff || record || (!text && !close)) {
      // The model can't (or shouldn't) answer — or an agent registered its
      // work for review — hand the thread to a human. An agent's message to
      // the customer goes out first; the record goes only to the team.
      if (agent && text) {
        await engineSendText({
          accountId,
          userId: configOwnerUserId,
          conversationId,
          contactId,
          text,
          aiGenerated: true,
        })
      }
      await handOffToHuman(
        db,
        conversationId,
        messages,
        conv.ai_reply_count ?? 0,
        agent ? agent.handoff_user_id : config.handoffAgentId,
        record ? recordSummary(record) : undefined,
      )
      return
    }

    // Atomically claim a reply slot: the cap check + increment happen in
    // one UPDATE, so concurrent inbounds can never overshoot the cap. If
    // another inbound just took the last slot, `claimed` is false and we
    // skip the send. (We consume a slot slightly before the send lands —
    // fail-safe: under-reply rather than over-reply.)
    const { data: claimed, error: claimErr } = await db.rpc(
      'claim_ai_reply_slot',
      {
        conversation_id: conversationId,
        max_replies: maxReplies,
      },
    )
    if (claimErr) {
      // A real error here (vs. losing the cap race) is almost always a
      // deploy issue — e.g. `claim_ai_reply_slot` not EXECUTE-able by the
      // service role, or the migration not applied. Log it loudly: a
      // silent return makes "auto-reply never fires" undiagnosable.
      console.error('[ai auto-reply] claim_ai_reply_slot failed:', claimErr)
      return
    }
    if (claimed !== true) return // lost the per-conversation cap race

    if (text) {
      await engineSendText({
        accountId,
        userId: configOwnerUserId,
        conversationId,
        contactId,
        text,
        aiGenerated: true,
      })
    }
    // Agent finished the job: close (the next inbound reopens and restarts the URA).
    if (close) {
      await db
        .from('conversations')
        .update({ status: 'closed', updated_at: new Date().toISOString() })
        .eq('id', conversationId)
    }
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}

/**
 * Best-effort "typing…" for the inbound we're about to answer. Swallows
 * every failure (no WhatsApp config, bad token, Meta 4xx) with a warning
 * — the indicator is cosmetic, the reply is not.
 */
async function showTypingIndicator(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  inboundMessageId: string,
): Promise<void> {
  try {
    const { phoneNumberId, accessToken } = await loadAccountMetaCredentials(
      db,
      accountId,
    )
    await sendTypingIndicator({
      phoneNumberId,
      accessToken,
      messageId: inboundMessageId,
    })
  } catch (err) {
    console.warn('[ai auto-reply] typing indicator failed (continuing):', err)
  }
}
/**
 * Stop auto-replying on this thread and hand it to a human: pause the bot
 * (sticky until a flow hands it to an agent again), leave a short internal
 * note, and route to the configured handoff agent — null leaves it in the
 * shared queue. Assigning fires `on_conversation_assigned`, which notifies
 * the agent. Callers have already returned when a human owns the thread.
 */
async function handOffToHuman(
  db: ReturnType<typeof supabaseAdmin>,
  conversationId: string,
  messages: Awaited<ReturnType<typeof buildConversationContext>>,
  replyCount: number,
  handoffAgentId: string | null,
  summary?: string,
): Promise<void> {
  const update: Record<string, unknown> = {
    ai_autoreply_disabled: true,
    ai_handoff_summary: summary ?? buildHandoffSummary({ messages, replyCount }),
  }
  if (handoffAgentId) update.assigned_agent_id = handoffAgentId
  await db.from('conversations').update(update).eq('id', conversationId)
}
