// Diagnóstico da conta WhatsApp na Meta usando o token salvo no CRM (nunca é impresso).
// Uso: node --env-file=.env.local scripts/meta-diag.mts
import { decrypt } from '../src/lib/whatsapp/encryption.ts'

const K = process.env.SUPABASE_SERVICE_ROLE_KEY!
const U = process.env.NEXT_PUBLIC_SUPABASE_URL!
const [cfg] = await fetch(`${U}/rest/v1/whatsapp_config?select=phone_number_id,waba_id,access_token`, {
  headers: { apikey: K, Authorization: `Bearer ${K}` },
}).then((r) => r.json())
const token = decrypt(cfg.access_token)

const g = async (path: string) => {
  const r = await fetch(`https://graph.facebook.com/v21.0/${path}`, { headers: { Authorization: `Bearer ${token}` } })
  return r.json()
}

const out = {
  phone: await g(`${cfg.phone_number_id}?fields=display_phone_number,verified_name,status,name_status,code_verification_status,quality_rating,platform_type,account_mode,messaging_limit_tier,throughput,health_status`),
  waba: await g(`${cfg.waba_id}?fields=name,account_review_status,business_verification_status,ownership_type,health_status,primary_funding_id`),
  subscribed_apps: await g(`${cfg.waba_id}/subscribed_apps`),
  token_debug: await g(`debug_token?input_token=${token}`).then((d) => d.data && {
    app_id: d.data.app_id, type: d.data.type, is_valid: d.data.is_valid, expires_at: d.data.expires_at, scopes: d.data.scopes,
    granular_scopes: d.data.granular_scopes,
  }),
}
console.log(JSON.stringify(out, null, 2))
