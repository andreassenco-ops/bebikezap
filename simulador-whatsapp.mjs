// Simulador local de WhatsApp para testar o wacrm sem a Meta.
//  - Em http://localhost:4000 abre um "celular" onde voce escreve como cliente.
//  - Faz o papel da Graph API da Meta (META_API_BASE_URL aponta para ca).
// Rodar:  node --env-file=.env.local simulador-whatsapp.mjs
// Conectar no CRM (Configuracoes > WhatsApp): Phone Number ID 100000000000001,
// WABA ID 200000000000001, qualquer token.
import http from 'node:http'
import crypto from 'node:crypto'

const PORT = 4000
const PHONE_ID = '100000000000001'
const WABA_ID = '200000000000001'
const DISPLAY = '+55 11 4000-0000'
const WEBHOOK = process.env.CRM_WEBHOOK_URL || 'http://localhost:3000/api/whatsapp/webhook'
const SECRET = (process.env.META_APP_SECRET || '').split(',')[0].trim()
if (!SECRET) throw new Error('META_APP_SECRET ausente: rode com --env-file=.env.local')

// ponytail: mensagens so em memoria, somem ao reiniciar o simulador
const msgs = [] // { dir: 'in' | 'out', phone, payload, ts }
let seq = 0

async function sendWebhook(phone, name, message) {
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: WABA_ID, changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: DISPLAY.replace(/\D/g, ''), phone_number_id: PHONE_ID },
      contacts: [{ profile: { name }, wa_id: phone }],
      messages: [{ from: phone, id: `wamid.SIMIN${Date.now()}${++seq}`, timestamp: String(Math.floor(Date.now() / 1000)), ...message }],
    } }] }],
  })
  const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex')
  const res = await fetch(WEBHOOK, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sig }, body })
  if (!res.ok) throw new Error(`CRM respondeu ${res.status}: ${await res.text()}`)
}

// Respostas falsas da Graph API, so o que o wacrm usa.
function graph(method, parts, body) {
  const [id, edge] = parts
  if (edge === 'messages') {
    if (body.status) return { success: true } // marcar como lida / digitando
    const to = body.to || body.recipient
    const wamid = `wamid.SIMOUT${Date.now()}${++seq}`
    msgs.push({ dir: 'out', phone: to, payload: body, ts: Date.now() })
    return { messaging_product: 'whatsapp', contacts: [{ input: to, wa_id: to }], messages: [{ id: wamid }] }
  }
  if (edge === 'phone_numbers') return { data: [{ id: PHONE_ID, display_phone_number: DISPLAY, verified_name: 'Simulador' }] }
  if (edge === 'subscribed_apps') return method === 'GET' ? { data: [{ whatsapp_business_api_data: { id: 'sim', name: 'Simulador' } }] } : { success: true }
  if (edge === 'message_templates') return method === 'GET' ? { data: [] } : { id: `sim-tpl-${++seq}`, status: 'PENDING' }
  if (!edge && method === 'GET') return { id, display_phone_number: DISPLAY, verified_name: 'Simulador', quality_rating: 'GREEN' }
  return { success: true, id: `sim-${++seq}` }
}

const json = (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  const body = raw ? JSON.parse(raw) : {}
  try {
    if (url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(PAGE) }
    if (url.pathname === '/sim/messages') return json(res, 200, msgs.filter((m) => m.phone === url.searchParams.get('phone')))
    if (url.pathname === '/sim/send') {
      const { phone, name, text, reply } = body
      const message = reply
        ? { type: 'interactive', interactive: reply.kind === 'list'
            ? { type: 'list_reply', list_reply: { id: reply.id, title: reply.title } }
            : { type: 'button_reply', button_reply: { id: reply.id, title: reply.title } } }
        : { type: 'text', text: { body: text } }
      await sendWebhook(phone, name, message)
      msgs.push({ dir: 'in', phone, payload: message, ts: Date.now() })
      return json(res, 200, { ok: true })
    }
    const parts = url.pathname.split('/').filter(Boolean) // ['v21.0', id, edge]
    if (/^v\d+/.test(parts[0])) {
      console.log(req.method, url.pathname, body.type || '')
      return json(res, 200, graph(req.method, parts.slice(1), body))
    }
    json(res, 404, { error: { message: 'not found' } })
  } catch (err) {
    console.error(err)
    json(res, 500, { error: { message: String(err.message || err) } })
  }
}).listen(PORT, () => console.log(`Simulador em http://localhost:${PORT} -> webhook ${WEBHOOK}`))

const PAGE = `<!doctype html><html lang="pt-br"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Simulador WhatsApp</title><style>
*{box-sizing:border-box}body{margin:0;font:15px system-ui,sans-serif;background:#d1d7db;display:flex;justify-content:center}
.phone{width:100%;max-width:420px;height:100vh;display:flex;flex-direction:column;background:#efeae2}
header{background:#008069;color:#fff;padding:10px 12px;display:flex;gap:6px;flex-wrap:wrap;align-items:center}
header b{width:100%}header input{flex:1;min-width:0;padding:6px;border:0;border-radius:6px}
#chat{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:6px}
.m{max-width:85%;padding:7px 9px;border-radius:8px;white-space:pre-wrap;box-shadow:0 1px 1px #0002;background:#fff;align-self:flex-start}
.in{background:#d9fdd3;align-self:flex-end}.h{font-weight:600}.f{color:#667781;font-size:12px}
.btns{display:flex;flex-direction:column;gap:4px;margin-top:6px}
.btns button{background:#fff;border:1px solid #d1d7db;color:#008069;padding:7px;border-radius:6px;cursor:pointer;font-weight:600}
.btns button small{display:block;color:#667781;font-weight:400}
form{display:flex;gap:6px;padding:8px;background:#f0f2f5}form input{flex:1;padding:10px;border:0;border-radius:20px}
form button{border:0;background:#008069;color:#fff;border-radius:20px;padding:0 16px}#err{color:#b00;padding:0 8px}
</style></head><body><div class="phone">
<header><b>Simulador de cliente</b><input id="name" value="Cliente Teste" aria-label="Nome"><input id="phone" value="5511999990001" aria-label="Telefone"></header>
<div id="chat"></div><div id="err"></div>
<form id="f"><input id="t" placeholder="Mensagem" autocomplete="off" aria-label="Mensagem"><button>Enviar</button></form></div>
<script>
const $=(id)=>document.getElementById(id), esc=(s)=>String(s??'').replace(/[&<>"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))
async function send(data){$('err').textContent='';const r=await fetch('/sim/send',{method:'POST',body:JSON.stringify({phone:$('phone').value,name:$('name').value,...data})});if(!r.ok)$('err').textContent=(await r.json()).error.message;load()}
$('f').onsubmit=(e)=>{e.preventDefault();const t=$('t').value.trim();if(t){$('t').value='';send({text:t})}}
function render(m){const p=m.payload
 if(m.dir==='in')return '<div class="m in">'+esc(p.text?.body??'🔘 '+(p.interactive.button_reply||p.interactive.list_reply).title)+'</div>'
 if(p.type==='text')return '<div class="m">'+esc(p.text.body)+'</div>'
 if(p.type==='interactive'){const i=p.interactive;let h=(i.header?'<div class="h">'+esc(i.header.text)+'</div>':'')+esc(i.body.text)+(i.footer?'<div class="f">'+esc(i.footer.text)+'</div>':'')
  const opts=i.type==='button'?i.action.buttons.map((b)=>['button',b.reply.id,b.reply.title,'']):i.action.sections.flatMap((s)=>s.rows.map((r)=>['list',r.id,r.title,r.description||'']))
  if(i.type==='list')h+='<div class="f">☰ '+esc(i.action.button)+'</div>'
  return '<div class="m">'+h+'<div class="btns">'+opts.map((o)=>'<button data-o="'+esc(JSON.stringify(o))+'">'+esc(o[2])+(o[3]?'<small>'+esc(o[3])+'</small>':'')+'</button>').join('')+'</div></div>'}
 if(p.type==='template')return '<div class="m">📄 Template: <b>'+esc(p.template.name)+'</b></div>'
 const media=p[p.type]||{};return '<div class="m">['+esc(p.type)+'] '+esc(media.caption||media.filename||media.link||'')+'</div>'}
$('chat').onclick=(e)=>{const b=e.target.closest('button[data-o]');if(b){const [kind,id,title]=JSON.parse(b.dataset.o);send({reply:{kind,id,title}})}}
let last='';async function load(){const r=await fetch('/sim/messages?phone='+encodeURIComponent($('phone').value));const t=await r.text();if(t!==last){last=t;$('chat').innerHTML=JSON.parse(t).map(render).join('');$('chat').scrollTop=1e9}}
setInterval(load,1000);load()
</script></body></html>`
