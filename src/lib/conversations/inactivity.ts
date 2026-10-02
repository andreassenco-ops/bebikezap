import { supabaseAdmin } from '@/lib/flows/admin-client'
import { engineSendText } from '@/lib/flows/meta-send'

export const INACTIVITY_MINUTES = 20
export const INACTIVITY_MESSAGE =
  'Estamos finalizando seu atendimento por inatividade. Caso necessite, entre em contato conosco novamente com o Klett.\n\nMuito obrigado.'

/**
 * Closes open conversations where the last message is ours (bot or agent) and the
 * customer hasn't answered for INACTIVITY_MINUTES: sends the goodbye (same as the
 * atenderbem URA), ends any active flow run, closes. Called every minute by the
 * flows cron. A conversation whose last message is the customer's is skipped —
 * that is the agent's delay, handled by the pool return (migration 045); so is one
 * waiting in the human queue (conversation_queue).
 */
export async function closeInactiveConversations(now = new Date()): Promise<number> {
  const db = supabaseAdmin()
  const cutoff = new Date(now.getTime() - INACTIVITY_MINUTES * 60_000).toISOString()
  const { data: convs, error } = await db
    .from('conversations')
    .select('id, account_id, user_id, contact_id')
    .neq('status', 'closed')
    .lt('last_message_at', cutoff)
  if (error) {
    console.error('[inactivity] scan failed:', error.message)
    return 0
  }

  // Customers waiting for a human (Aguardando pool) are not inactive — we owe them the reply.
  const { data: queued } = await db.from('conversation_queue').select('id')
  const waitingForHuman = new Set((queued ?? []).map((q) => q.id as string))

  let closed = 0
  for (const c of convs ?? []) {
    if (waitingForHuman.has(c.id)) continue
    const { data: last } = await db
      .from('messages')
      .select('sender_type')
      .eq('conversation_id', c.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!last || last.sender_type === 'customer') continue

    try {
      await engineSendText({
        accountId: c.account_id,
        userId: c.user_id,
        conversationId: c.id,
        contactId: c.contact_id,
        text: INACTIVITY_MESSAGE,
      })
    } catch (err) {
      // Close anyway (e.g. 24h window expired): the customer left either way.
      console.error('[inactivity] goodbye failed for', c.id, err instanceof Error ? err.message : err)
    }
    const stamp = now.toISOString()
    await db
      .from('flow_runs')
      .update({ status: 'timed_out', ended_at: stamp, end_reason: 'inactivity' })
      .eq('conversation_id', c.id)
      .eq('status', 'active')
    await db.from('conversations').update({ status: 'closed', updated_at: stamp }).eq('id', c.id)
    closed++
  }
  return closed
}
