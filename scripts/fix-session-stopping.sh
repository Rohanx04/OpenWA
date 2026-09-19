#!/usr/bin/env bash
#
# Apply the "session stops after a few hours and needs a manual Start" fixes to a
# SINGLE-INSTANCE deployment. Run it from the directory holding docker-compose.yml.
#
# What it does, in order:
#   0. Captures diagnostics FIRST (lastError is in-memory and is lost on restart).
#   1. AUTO_START_SESSIONS=true + a stable NODE_ID, so a restart re-starts the session
#      instead of leaving it disconnected until someone clicks Start.
#   2. Raises OPENWA_MEM_LIMIT, so a Chromium that grows over hours is not OOM-killed.
#   3. Rebuilds at the current checkout (>= 0.23.3 fixes the double auto-start at boot).
#
# SINGLE INSTANCE ONLY. AUTO_START_SESSIONS on two replicas pointed at one database can
# open the same WhatsApp account twice, which risks a forced logout or ban. SQLite plus a
# local storage path cannot be shared across replicas anyway, which is why this is safe here.
#
# Usage:
#   ./scripts/fix-session-stopping.sh              # apply, with a confirmation prompt
#   ./scripts/fix-session-stopping.sh --dry-run    # show what would change, touch nothing
#   ./scripts/fix-session-stopping.sh --yes        # no prompt
#   MEM_LIMIT=6g ./scripts/fix-session-stopping.sh # override the memory ceiling
#
set -euo pipefail

SERVICE="openwa-api"
ENV_FILE=".env"
STAMP="$(date +%Y%m%d-%H%M%S)"
DIAG_DIR="./session-stop-diagnostics-${STAMP}"
DRY_RUN=0
ASSUME_YES=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --yes|-y)  ASSUME_YES=1 ;;
    --help|-h) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $arg (try --help)" >&2; exit 2 ;;
  esac
done

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '  \033[33m! %s\033[0m\n' "$*"; }

# docker compose (v2) or docker-compose (v1)
if docker compose version >/dev/null 2>&1; then
  DC=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  DC=(docker-compose)
else
  echo "Neither 'docker compose' nor 'docker-compose' is available." >&2
  exit 1
fi

[ -f docker-compose.yml ] || { echo "No docker-compose.yml here. cd to the deploy directory first." >&2; exit 1; }

# ---------------------------------------------------------------------------
# 0. Diagnostics, before anything restarts
# ---------------------------------------------------------------------------
say "0. Capturing diagnostics into ${DIAG_DIR}"
mkdir -p "$DIAG_DIR"

# Was the container OOM-killed, and how often has it restarted? This is the evidence that
# says whether the memory ceiling (step 2) is the real cause or a precaution.
if docker inspect "$SERVICE" >/dev/null 2>&1; then
  docker inspect "$SERVICE" \
    --format 'OOMKilled={{.State.OOMKilled}} RestartCount={{.RestartCount}} Status={{.State.Status}} StartedAt={{.State.StartedAt}}' \
    | tee "$DIAG_DIR/container-state.txt"
  docker stats "$SERVICE" --no-stream --format 'MemUsage={{.MemUsage}} MemPerc={{.MemPerc}}' \
    2>/dev/null | tee "$DIAG_DIR/mem.txt" || true

  # The reason the session went down. Terminal-unlink audit lines and reconnect
  # exhaustion both show up here; the container log is the only durable copy.
  docker logs "$SERVICE" --since 72h 2>&1 \
    | grep -Ei 'disconnected|reconnect_failed|reconnect_loop|auto_start|watchdog_disconnect|auth_failure|relink_required|Max reconnect' \
    > "$DIAG_DIR/session-events.log" 2>/dev/null || true
  info "Session events captured: $(wc -l < "$DIAG_DIR/session-events.log" 2>/dev/null || echo 0) line(s)"
else
  warn "Container '$SERVICE' not found — skipping container diagnostics."
fi

# lastError is per-process and in memory only: it does not survive the restart below.
if [ -n "${OPENWA_API_KEY:-}" ]; then
  PORT="$(grep -E '^API_PORT=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2 || true)"
  curl -fsS -H "X-API-Key: ${OPENWA_API_KEY}" \
    "http://127.0.0.1:${PORT:-2785}/api/sessions" > "$DIAG_DIR/sessions-before.json" 2>/dev/null \
    && info "Session status + lastError saved (read it before restarting)." \
    || warn "Could not read /api/sessions — carry on, the logs above still have the reason."
else
  info "Set OPENWA_API_KEY to also capture each session's status and lastError."
fi

# ---------------------------------------------------------------------------
# 1 + 2. Environment
# ---------------------------------------------------------------------------

# Total host RAM decides how far the ceiling can go. Asking for more than the host has
# would just move the kill from the cgroup to the kernel's OOM killer.
TOTAL_MB="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)"
if [ -n "${MEM_LIMIT:-}" ]; then
  TARGET_MEM="$MEM_LIMIT"
elif [ "$TOTAL_MB" -ge 8192 ]; then
  TARGET_MEM="4g"
elif [ "$TOTAL_MB" -ge 6144 ]; then
  TARGET_MEM="3g"
else
  TARGET_MEM=""
fi

say "1+2. Environment changes"
info "Host RAM: ${TOTAL_MB} MB"
if [ -z "$TARGET_MEM" ]; then
  warn "Under 6 GB of host RAM — leaving OPENWA_MEM_LIMIT alone."
  warn "Raising the cgroup ceiling above what the host has does not prevent an OOM kill."
  warn "On a box this size, switching to ENGINE_TYPE=baileys (no Chromium) is the real fix."
fi

# Set a key to a value: replace it in place if present (commented or not), else append.
# Idempotent, so re-running the script changes nothing.
upsert_env() {
  local key="$1" val="$2" file="$3"
  if grep -qE "^[[:space:]]*#?[[:space:]]*${key}=" "$file" 2>/dev/null; then
    local current
    current="$(grep -E "^${key}=" "$file" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
    if [ "$current" = "$val" ]; then
      info "${key}=${val} (already set)"
      return
    fi
    # Only the LAST occurrence wins in a dotenv file, so rewrite every one of them.
    sed -i -E "s|^[[:space:]]*#?[[:space:]]*${key}=.*$|${key}=${val}|" "$file"
    info "${key}=${val} (updated)"
  else
    # A .env whose last line has no trailing newline would otherwise get the new key glued
    # onto it (FOO=1BAR=2), silently corrupting both.
    if [ -s "$file" ] && [ "$(tail -c 1 "$file" | wc -l)" -eq 0 ]; then
      printf '\n' >> "$file"
    fi
    printf '%s=%s\n' "$key" "$val" >> "$file"
    info "${key}=${val} (added)"
  fi
}

if [ "$DRY_RUN" = "1" ]; then
  warn "Dry run: would set AUTO_START_SESSIONS=true, NODE_ID=openwa-1${TARGET_MEM:+, OPENWA_MEM_LIMIT=$TARGET_MEM}"
else
  if [ ! -f "$ENV_FILE" ]; then
    warn "No .env found — creating one. Review it against .env.example afterwards."
    : > "$ENV_FILE"
  fi
  cp "$ENV_FILE" "${ENV_FILE}.bak-${STAMP}"
  info "Backed up .env to ${ENV_FILE}.bak-${STAMP}"

  # The compose file forwards AUTO_START_SESSIONS blank by default, and the app reads the
  # exact string "true" — anything else leaves boot auto-start off.
  upsert_env "AUTO_START_SESSIONS" "true" "$ENV_FILE"

  # Without this the node identity defaults to the container hostname, which changes on
  # every `up -d` recreate. The new container then reads its own previous sessions as
  # belonging to a foreign node and waits out the old lease before it may adopt them.
  upsert_env "NODE_ID" "openwa-1" "$ENV_FILE"

  [ -n "$TARGET_MEM" ] && upsert_env "OPENWA_MEM_LIMIT" "$TARGET_MEM" "$ENV_FILE"
fi

# ---------------------------------------------------------------------------
# 3. Version
# ---------------------------------------------------------------------------
say "3. Version"
LOCAL_VERSION="$(grep -m1 '"version"' package.json 2>/dev/null | cut -d'"' -f4 || echo unknown)"
info "Checkout is at v${LOCAL_VERSION} (0.23.3 or newer carries the double-auto-start fix)"

if git rev-parse --git-dir >/dev/null 2>&1; then
  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    warn "Working tree has local changes — not pulling. Rebuilding at the current checkout."
  else
    info "Fetching origin..."
    git fetch origin --quiet 2>/dev/null || warn "Fetch failed (offline?) — rebuilding at the current checkout."
    BRANCH="$(git rev-parse --abbrev-ref HEAD)"
    if git rev-parse --verify --quiet "origin/${BRANCH}" >/dev/null; then
      BEHIND="$(git rev-list --count "HEAD..origin/${BRANCH}" 2>/dev/null || echo 0)"
      if [ "$BEHIND" -gt 0 ]; then
        info "${BEHIND} commit(s) behind origin/${BRANCH}"
        [ "$DRY_RUN" = "1" ] || git merge --ff-only "origin/${BRANCH}" \
          || warn "Fast-forward refused — merge by hand, then re-run."
      else
        info "Already up to date with origin/${BRANCH}"
      fi
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Apply
# ---------------------------------------------------------------------------
if [ "$DRY_RUN" = "1" ]; then
  # Leave no empty diagnostics directory behind when there was nothing to collect.
  rmdir "$DIAG_DIR" 2>/dev/null || true
  say "Dry run complete — nothing was changed."
  exit 0
fi

say "Rebuild and restart"
warn "This restarts the gateway. The session reconnects from its stored credentials —"
warn "no new QR scan is needed. Expect roughly a minute of downtime."
if [ "$ASSUME_YES" != "1" ]; then
  printf '  Continue? [y/N] '
  read -r reply
  case "$reply" in
    [yY]|[yY][eE][sS]) ;;
    *) echo "  Aborted. Your .env changes are saved and take effect on the next restart."; exit 0 ;;
  esac
fi

"${DC[@]}" build "$SERVICE"
"${DC[@]}" up -d "$SERVICE"

say "Verifying"
info "Waiting for the gateway to answer..."
PORT="$(grep -E '^API_PORT=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2 || true)"
PORT="${PORT:-2785}"
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    info "Health endpoint is answering."
    break
  fi
  sleep 2
done

# Auto-start is deliberately detached from the bootstrap hook, so the port opens before the
# sessions finish launching. Chromium needs a moment; give it one before reading status.
info "Giving auto-start time to launch the engine..."
sleep 20
docker logs "$SERVICE" --since 3m 2>&1 | grep -Ei 'auto_start|Auto-start' | tail -20 \
  || warn "No auto-start lines yet — check 'docker logs -f ${SERVICE}'."

say "Done"
cat <<EOF
  Applied:
    1. AUTO_START_SESSIONS=true + stable NODE_ID  -> a restart now re-starts the session
    2. OPENWA_MEM_LIMIT=${TARGET_MEM:-unchanged}
    3. Rebuilt at v${LOCAL_VERSION}

  Diagnostics saved in ${DIAG_DIR} — read container-state.txt first:
  a non-zero RestartCount or OOMKilled=true confirms the memory ceiling was the cause.

  Still to do (fix 4, deferred): ENGINE_TYPE=baileys drops Chromium entirely and
  removes this failure mode. It needs one fresh QR scan.

  Auto-start only recovers a session in 'disconnected'. If it stops again and the
  status reads 'failed', capture lastError BEFORE restarting:
    OPENWA_API_KEY=... ./scripts/fix-session-stopping.sh --dry-run
EOF
