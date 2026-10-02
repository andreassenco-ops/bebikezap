// Cria em massa os usuários de scripts/usuarios.txt na conta (workspace) do dono,
// com o mesmo efeito de aceitar um convite: perfil movido para a conta do dono e a
// conta pessoal vazia criada pelo cadastro é apagada. Usuários já existentes são pulados.
//
// Uso: SENHA_INICIAL='...' node --env-file=.env.local scripts/criar-usuarios.mts <email_do_dono> [papel=agent]
import fs from 'node:fs'

const [ownerEmail, role = 'agent'] = process.argv.slice(2)
const password = process.env.SENHA_INICIAL
if (!ownerEmail || !password || !['admin', 'agent', 'viewer'].includes(role)) {
  console.error("Uso: SENHA_INICIAL='...' node --env-file=.env.local scripts/criar-usuarios.mts <email_do_dono> [admin|agent|viewer]")
  process.exit(1)
}

const K = process.env.SUPABASE_SERVICE_ROLE_KEY!, U = process.env.NEXT_PUBLIC_SUPABASE_URL!
const h = { apikey: K, Authorization: `Bearer ${K}`, 'Content-Type': 'application/json' }
const rest = (path: string, init: RequestInit = {}) =>
  fetch(`${U}/rest/v1/${path}`, { ...init, headers: { ...h, Prefer: 'return=representation', ...init.headers } }).then((r) => r.json())

// "ana.goncalves" -> "Ana Goncalves"; caixas curtas viram sigla ("rh" -> "RH").
const nameFrom = (email: string) =>
  email.split('@')[0].split('.').map((p) => (p.length <= 3 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1))).join(' ')

const [owner] = await rest(`profiles?select=account_id&email=eq.${encodeURIComponent(ownerEmail)}`)
if (!owner?.account_id) throw new Error(`Dono ${ownerEmail} não encontrado`)

const emails = fs.readFileSync(new URL('./usuarios.txt', import.meta.url), 'utf8').split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter(Boolean)
const existing = new Set((await rest('profiles?select=email')).map((p: { email: string }) => p.email?.toLowerCase()))

const result = { criados: 0, pulados: 0, erros: [] as string[] }
for (const email of emails) {
  if (existing.has(email)) { result.pulados++; continue }
  const full_name = nameFrom(email)
  const r = await fetch(`${U}/auth/v1/admin/users`, {
    method: 'POST', headers: h,
    body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { full_name } }),
  })
  const user = await r.json()
  if (!r.ok) { result.erros.push(`${email}: ${user.msg ?? user.message ?? r.status}`); continue }

  // O gatilho handle_new_user criou uma conta pessoal; mover para a conta do dono e apagar a pessoal.
  const [profile] = await rest(`profiles?select=account_id&user_id=eq.${user.id}`)
  await rest(`profiles?user_id=eq.${user.id}`, { method: 'PATCH', body: JSON.stringify({ account_id: owner.account_id, account_role: role }) })
  if (profile?.account_id && profile.account_id !== owner.account_id)
    await rest(`accounts?id=eq.${profile.account_id}&owner_user_id=eq.${user.id}`, { method: 'DELETE' })
  result.criados++
}
console.log(JSON.stringify(result, null, 2))
