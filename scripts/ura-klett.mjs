// Gera os nós do fluxo "URA Laboratório Klett" (cópia da URA API OFICIAL do atenderbem).
// Uso: node scripts/ura-klett.mjs <tags.json>  -> imprime JSON { trigger_config, fallback_policy, nodes }
import fs from 'node:fs'

const tags = Object.fromEntries(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).map((t) => [t.name, t.id]))
const tag = (name) => {
  if (!tags[name]) throw new Error(`tag ausente: ${name}`)
  return tags[name]
}

const DIRECIONANDO = 'Obrigado pela resposta. \n\nEstou direcionando o atendimento para nosso time. \n\nUm momentinho por favor. 🥰'

// [reply_id, título na lista, descrição, tag, mensagem, próximo após a mensagem]
const options = [
  ['resultados', 'Resultados de Exames', 'Consultar resultados', 'Resultado de exames',
    'Vi que você está buscando resultados de exames. Você já sabe como consultar o resultado diretamente em nosso site?\n\n1) Acesse o link\nhttps://www.laboratorioklett.com/resultados-de-exames/\n\n2) Insira seu Login e senha que são *sigilosos* e estão no canto superior do protocolo entregue a você no ato do atendimento.',
    'mais_ajuda'],
  ['orcamento', 'Orçamento e Preços', 'Valores de exames e vacinas', 'Orçamento',
    'Obrigado pela resposta.\n\nPara seu orçamento vamos precisar de:\n\n*- Pedido / lista de Exames ou vacinas*\n*- Nome completo do paciente*\n*- Plano de saúde se for o caso.*'],
  ['pre_cadastro', 'Pré-Cadastro', 'Adiantar seu cadastro', 'PRE CADASTRO',
    DIRECIONANDO + '\n\n\nPara adiantar, por favor nos envie uma foto do documento do paciente, pedido médico (se tiver) e se for o caso sua carteirinha do plano.'],
  ['domiciliar', 'Coleta Domiciliar', 'Coleta na sua casa', 'DOMICILIAR', DIRECIONANDO],
  ['vacinas', 'Vacinas', 'Vacinação', 'Vacinas', DIRECIONANDO],
  ['preparo', 'Preparo para exames', 'Jejum e orientações', 'Preparo', DIRECIONANDO],
  ['rh', 'Dep. Pessoal', 'Trabalhe conosco', 'RH',
    'Ficamos felizes com seu interesse em trabalhar conosco. \n\nPor favor envie seu currículo que encaminharemos para o time de RH! \n\nBoa sorte no seu processo, ok?\n\nAté breve!'],
  ['notas_fiscais', 'Notas Fiscais', 'Financeiro', 'Notas Fiscais',
    'Estamos encaminhando para nosso time financeiro. Em alguns minutos atenderemos sua demanda.'],
  ['outros', 'Outros', 'Outros assuntos', 'Outros',
    'Para adiantar seu atendimento, sobre qual assunto deseja falar?\nEstou transferindo para um de nossos atendentes.'],
]

const nodes = [
  { node_key: 'start', node_type: 'start', config: { next_node_key: 'horario' } },
  { node_key: 'horario', node_type: 'condition', config: {
    subject: 'business_hours', subject_key: '1-5 06:00-18:30;6 06:30-12:00', operator: 'present',
    true_next: 'menu', false_next: 'fora_msg' } },
  { node_key: 'fora_msg', node_type: 'send_message', config: {
    text: 'Desculpe, no momento não temos atendentes Online.\n\nNosso horário de atendimento é:\n\n*De Segunda a Sexta-feira de 6h às 18h30m*\n*Sábado de 6h30m às 12h*\n\nEntraremos em contato mais breve possível.',
    next_node_key: 'fora_tag' } },
  { node_key: 'fora_tag', node_type: 'set_tag', config: { mode: 'add', tag_id: tag('FORA DO HORARIO'), next_node_key: 'fora_handoff' } },
  { node_key: 'fora_handoff', node_type: 'handoff', config: { note: 'Fora do horário — responder no próximo expediente' } },
  { node_key: 'menu', node_type: 'send_list', config: {
    text: 'Bem-vindo ao *Laboratório Klett*, Há 43 anos cuidando de você 🫂💉❤️.\n\nPara direcionar melhor seu atendimento, pedimos que responda abaixo:\n\nPor favor, *SELECIONE* a opção que deseja.',
    button_label: 'Selecione uma opção',
    sections: [{ title: 'Atendimento', rows: options.map(([id, title, description]) => ({ reply_id: id, title, description, next_node_key: `${id}_tag` })) }] } },
  ...options.flatMap(([id, title, , tagName, text, next]) => [
    { node_key: `${id}_tag`, node_type: 'set_tag', config: { mode: 'add', tag_id: tag(tagName), next_node_key: `${id}_msg` } },
    { node_key: `${id}_msg`, node_type: 'send_message', config: { text, next_node_key: next ?? `${id}_handoff` } },
    ...(next ? [] : [{ node_key: `${id}_handoff`, node_type: 'handoff', config: { note: `URA: ${title}` } }]),
  ]),
  { node_key: 'mais_ajuda', node_type: 'send_buttons', config: {
    text: 'Ajudo com algo mais?',
    buttons: [
      { reply_id: 'sim', title: 'SIM', next_node_key: 'resultados_handoff' },
      { reply_id: 'nao', title: 'NÃO', next_node_key: 'fim' },
    ] } },
  { node_key: 'resultados_handoff', node_type: 'handoff', config: { note: 'URA: Resultados de Exames (pediu mais ajuda)' } },
  { node_key: 'fim', node_type: 'end', config: {} },
]

console.log(JSON.stringify({
  trigger_config: {},
  // Opção inválida: repete o menu 1x, depois passa para um atendente (como o "Erro" da URA atual).
  fallback_policy: { on_unknown_reply: 'reprompt', max_reprompts: 1, on_exhaust: 'handoff', on_timeout_hours: 24 },
  nodes,
}))
