import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiConfig } from './types'
import { CLOSE_SENTINEL, RECORD_SENTINEL } from './defaults'

// Self-contained agents (ai_agents): instructions, model, welcome message,
// handoff target, reply cap and their own knowledge. Only the provider
// connection (ai_configs: provider + key) is shared.

export interface AgentRow {
  id: string
  system_prompt: string
  model: string
  welcome_message: string | null
  /** Who gets the conversation on handoff; null = the shared queue. */
  handoff_user_id: string | null
  max_replies: number
  is_active: boolean
}

export async function loadAgent(
  db: SupabaseClient,
  agentId: string,
): Promise<AgentRow | null> {
  const { data } = await db
    .from('ai_agents')
    .select('id, system_prompt, model, welcome_message, handoff_user_id, max_replies, is_active')
    .eq('id', agentId)
    .maybeSingle()
  return (data as AgentRow | null) ?? null
}

/** An agent runs on its own instructions only — nothing global is mixed in. */
export function agentUserPrompt(config: AiConfig, agent: AgentRow | null): string | null {
  return agent ? agent.system_prompt : config.systemPrompt
}

/** The account connection (provider + key) with the agent's own model. */
export function agentConfig(config: AiConfig, agent: AgentRow | null): AiConfig {
  return agent ? { ...config, model: agent.model } : config
}

/** Strip the agent's close marker: `{ text, close }`. */
export function splitClose(raw: string): { text: string; close: boolean } {
  return {
    text: raw.split(CLOSE_SENTINEL).join('').trim(),
    close: raw.includes(CLOSE_SENTINEL),
  }
}

/** Split off the team record: `{ text }` for the customer, `record` for the team. */
export function splitRecord(raw: string): { text: string; record: string | null } {
  const i = raw.indexOf(RECORD_SENTINEL)
  if (i < 0) return { text: raw, record: null }
  const record = raw.slice(i + RECORD_SENTINEL.length).trim()
  return { text: raw.slice(0, i).trim(), record: record || null }
}

/** Handoff note for the inbox banner; JSON records are pretty-printed. */
export function recordSummary(record: string): string {
  const json = record.replace(/^```(?:json)?\s*|\s*```$/g, '')
  try {
    return `📋 Registro do agente\n${JSON.stringify(JSON.parse(json), null, 2)}`
  } catch {
    return `📋 Registro do agente\n${record}`
  }
}
