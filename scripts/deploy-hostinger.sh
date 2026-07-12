#!/usr/bin/env bash
# =============================================================================
# OpenWA - Hostinger VPS deploy script (openwa.tachyel.com)
# =============================================================================
# One-command production deploy/update on a Hostinger VPS (Ubuntu/Debian).
# Run from the repository root ON THE VPS:
#
#   sudo bash scripts/deploy-hostinger.sh
#
# What it does:
#   1. Installs Docker Engine + compose plugin if missing (get.docker.com)
#   2. Creates .env from deploy/hostinger/.env.hostinger.example on first run
#      and generates strong API_MASTER_KEY / API_KEY_PEPPER values
#   3. Verifies DNS for the domain resolves to this server (warns if not —
#      Let's Encrypt issuance needs it)
#   4. Builds and starts the stack with the Hostinger TLS overlay
#      (docker-compose.yml + deploy/hostinger/docker-compose.hostinger.yml)
#   5. Waits for the API health endpoint and prints the access details
#
# Re-running is safe: it rebuilds the image from the current checkout and
# restarts only what changed. Data (sessions, media, SQLite DB, TLS certs)
# lives in named volumes and survives redeploys.
#
# Full walkthrough (VPS sizing, DNS records, firewall): docs/28-hostinger-deployment.md

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

ENV_FILE=".env"
ENV_TEMPLATE="deploy/hostinger/.env.hostinger.example"
COMPOSE_ARGS=(-f docker-compose.yml -f deploy/hostinger/docker-compose.hostinger.yml)

log()  { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[deploy]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[deploy]\033[0m %s\n' "$*" >&2; exit 1; }

# ── 1. Docker ────────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  log "Docker not found - installing via get.docker.com ..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi
docker compose version >/dev/null 2>&1 || fail "Docker compose plugin missing. Install docker-compose-plugin and re-run."

# ── 2. Environment file ──────────────────────────────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
  log "Creating $ENV_FILE from $ENV_TEMPLATE"
  cp "$ENV_TEMPLATE" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi

# Generate strong secrets on first run (production refuses empty/placeholder
# API_MASTER_KEY). Only fills keys that are still empty - never overwrites.
gen_secret() { openssl rand -hex 32; }
fill_secret() {
  local key="$1"
  if grep -qE "^${key}=$" "$ENV_FILE"; then
    local value
    value="$(gen_secret)"
    sed -i "s|^${key}=$|${key}=${value}|" "$ENV_FILE"
    log "Generated ${key}"
  fi
}
fill_secret API_MASTER_KEY
fill_secret API_KEY_PEPPER

# shellcheck disable=SC1090
DOMAIN_VALUE="$(grep -E '^OPENWA_DOMAIN=' "$ENV_FILE" | head -n1 | cut -d= -f2)"
DOMAIN_VALUE="${DOMAIN_VALUE:-openwa.tachyel.com}"

# ── 3. DNS sanity check ──────────────────────────────────────────────────────
SERVER_IP="$(curl -fsS -4 --max-time 10 https://ifconfig.me 2>/dev/null || true)"
DOMAIN_IP="$(getent ahostsv4 "$DOMAIN_VALUE" 2>/dev/null | awk 'NR==1 {print $1}' || true)"
if [ -n "$SERVER_IP" ] && [ -n "$DOMAIN_IP" ]; then
  if [ "$SERVER_IP" = "$DOMAIN_IP" ]; then
    log "DNS OK: $DOMAIN_VALUE -> $DOMAIN_IP (this server)"
  else
    warn "DNS MISMATCH: $DOMAIN_VALUE resolves to $DOMAIN_IP but this server is $SERVER_IP."
    warn "Let's Encrypt issuance will fail until the A record points here. Continuing anyway..."
  fi
else
  warn "Could not verify DNS for $DOMAIN_VALUE (no resolution yet?). TLS issuance needs it."
fi

# ── 4. Firewall (best effort) ────────────────────────────────────────────────
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then
  log "ufw active - allowing 80/tcp, 443/tcp, 443/udp"
  ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null && ufw allow 443/udp >/dev/null
fi

# ── 5. Build & start ─────────────────────────────────────────────────────────
log "Building and starting the stack (this builds the image on first run - takes a few minutes)"
docker compose "${COMPOSE_ARGS[@]}" up -d --build --remove-orphans

# ── 6. Wait for health ───────────────────────────────────────────────────────
log "Waiting for the API to become healthy ..."
for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${API_PORT:-2785}/api/health/ready" >/dev/null 2>&1; then
    log "API is healthy."
    break
  fi
  [ "$i" -eq 60 ] && { warn "API not healthy after 5 minutes - check: docker compose ${COMPOSE_ARGS[*]} logs openwa-api"; }
  sleep 5
done

MASTER_KEY="$(grep -E '^API_MASTER_KEY=' "$ENV_FILE" | head -n1 | cut -d= -f2)"
cat <<EOF

============================================================
 OpenWA deployed
============================================================
 Dashboard : https://${DOMAIN_VALUE}
 API base  : https://${DOMAIN_VALUE}/api
 Health    : https://${DOMAIN_VALUE}/api/health/ready
 Master key: ${MASTER_KEY}
             (X-Api-Key header; also the dashboard login key.
              Stored in ${REPO_ROOT}/.env - keep it secret.)

 Logs      : docker compose ${COMPOSE_ARGS[*]} logs -f
 Update    : git pull && sudo bash scripts/deploy-hostinger.sh
============================================================
EOF
