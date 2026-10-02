// Troca o número do CRM para outro já adicionado na Meta, em um passo:
// confere que o número pertence à conta (WABA), inscreve a conta no app (webhooks),
// registra o número na API de Nuvem com PIN e atualiza o CRM. Usa o token salvo no CRM (nunca impresso).
// O usuário do sistema "KlettZap CRM" precisa ter acesso à nova conta do WhatsApp.
//
// Uso: node --env-file=.env.local scripts/trocar-numero.mts <phone_number_id> <waba_id>
import crypto from 'node:crypto'
import fs from 'node:fs'
import { decrypt } from '../src/lib/whatsapp/encryption.ts'

const [phoneId, wabaId] = process.argv.slice(2)
if (!/^\d+$/.test(phoneId ?? '') || !/^\d+$/.test(wabaId ?? '')) {
  console.error('Uso: node --env-file=.env.local scripts/trocar-numero.mts <phone_number_id> <waba_id>')
  process.exit(1)
}

const K = process.env.SUPABASE_SERVICE_ROLE_KEY!, U = process.env.NEXT_PUBLIC_SUPABASE_URL!
const db = (path: string, init: RequestInit = {}) =>
  fetch(`${U}/rest/v1/${path}`, { ...init, headers: { apikey: K, Authorization: `Bearer ${K}`, 'Content-Type': 'application/json', ...init.headers } })
    .then((r) => r.json())

const [cfg] = await db('whatsapp_config?select=id,access_token')
const token = decrypt(cfg.access_token)
const graph = async (path: string, body?: object) => {
  const r = await fetch(`https://graph.facebook.com/v21.0/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  })
  const j = await r.json()
  if (j.error) throw new Error(`${path}: ${j.error.message}`)
  return j
}

// PIN de duas etapas: um por instalação, guardado no .env.local (sem ele não dá para re-registrar).
let pin = process.env.WHATSAPP_REGISTER_PIN
if (!pin) {
  pin = String(crypto.randomInt(100000, 999999))
  fs.appendFileSync('.env.local', `\n# PIN de duas etapas usado no /register dos números do CRM\nWHATSAPP_REGISTER_PIN=${pin}\n`)
}

const numbers = await graph(`${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name`)
const phone = numbers.data.find((n: { id: string }) => n.id === phoneId)
if (!phone) throw new Error(`O número ${phoneId} não está na conta ${wabaId}: ${JSON.stringify(numbers.data)}`)
console.log('1/4 número encontrado:', phone.display_phone_number, '-', phone.verified_name)

await graph(`${wabaId}/subscribed_apps`, {})
console.log('2/4 conta inscrita no app (webhooks)')

await graph(`${phoneId}/register`, { messaging_product: 'whatsapp', pin })
console.log('3/4 número registrado na API de Nuvem')

const now = new Date().toISOString()
await db(`whatsapp_config?id=eq.${cfg.id}`, {
  method: 'PATCH',
  body: JSON.stringify({
    phone_number_id: phoneId, waba_id: wabaId, status: 'connected', connected_at: now,
    registered_at: now, subscribed_apps_at: now, last_registration_error: null, updated_at: now,
  }),
})
console.log('4/4 CRM atualizado')

const health = await graph(`${phoneId}?fields=health_status`)
console.log('Saúde na Meta:', health.health_status.can_send_message)
for (const e of health.health_status.entities ?? [])
  for (const err of e.errors ?? []) if (!/SIP/.test(err.error_description)) console.log(' ', e.entity_type, err.error_code, err.error_description)
