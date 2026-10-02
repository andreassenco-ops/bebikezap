#!/usr/bin/env bash
# Publica o KlettZap no Fly.io (São Paulo, 2 máquinas) e liga os crons no Supabase.
# Pré-requisitos: flyctl instalado e logado (`fly auth login`), .env.local preenchido.
# Uso: bash scripts/deploy-fly.sh
set -euo pipefail
cd "$(dirname "$0")/.."

APP=$(sed -n 's/^app = "\(.*\)"/\1/p' fly.toml)
URL="https://$APP.fly.dev"

fly apps list | grep -q "^$APP\b" || fly apps create "$APP"

# Só os segredos de servidor (NEXT_PUBLIC_* vão no build; simulador e dry-run ficam de fora).
grep -E '^(SUPABASE_SERVICE_ROLE_KEY|ENCRYPTION_KEY|META_APP_SECRET|META_APP_ID|AUTOMATION_CRON_SECRET)=' .env.local \
  | fly secrets import --app "$APP" --stage

fly deploy --app "$APP" --ha=true

# Diz ao banco onde chamar os crons (tabela app_cron_config, migração 044).
node --env-file=.env.local -e '
const K = process.env.SUPABASE_SERVICE_ROLE_KEY, U = process.env.NEXT_PUBLIC_SUPABASE_URL;
fetch(U + "/rest/v1/app_cron_config", {
  method: "POST",
  headers: { apikey: K, Authorization: "Bearer " + K, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
  body: JSON.stringify({ id: true, app_url: process.argv[1], cron_secret: process.env.AUTOMATION_CRON_SECRET }),
}).then((r) => { if (!r.ok) throw new Error("app_cron_config: HTTP " + r.status); console.log("crons apontando para", process.argv[1]); });
' "$URL"

echo "Pronto: $URL — troque o webhook na Meta para $URL/api/whatsapp/webhook"
