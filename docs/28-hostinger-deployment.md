# Hostinger Deployment Guide — openwa.tachyel.com

This guide deploys OpenWA on a **Hostinger VPS** and serves it at
**https://openwa.tachyel.com** with automatic Let's Encrypt TLS.

> **Why a VPS and not Hostinger shared/web hosting?** OpenWA is a long-running
> Node.js server that keeps persistent WhatsApp sessions alive and runs a full
> Chromium browser per session (whatsapp-web.js engine). Hostinger's shared /
> Premium / Business web-hosting plans only run PHP + static sites and cannot
> host it. Any Hostinger **KVM VPS** plan works.

Everything below is already in the repository:

| File | Purpose |
| --- | --- |
| `deploy/hostinger/docker-compose.hostinger.yml` | Compose overlay adding the Caddy TLS reverse proxy (ports 80/443) |
| `deploy/hostinger/Caddyfile` | Proxy config for `openwa.tachyel.com` with automatic Let's Encrypt |
| `deploy/hostinger/.env.hostinger.example` | Production environment template for the domain |
| `scripts/deploy-hostinger.sh` | One-command install/deploy/update script for the VPS |
| `.github/workflows/deploy-hostinger.yml` | Optional: redeploy from GitHub Actions over SSH |

---

## 1. Provision the VPS

1. In [hpanel.hostinger.com](https://hpanel.hostinger.com) buy/open a **VPS** plan.
   - **Minimum:** KVM 1 (4 GB RAM) — fine for 1–2 WhatsApp sessions or the
     lightweight Baileys engine.
   - **Recommended:** KVM 2 (8 GB RAM) — whatsapp-web.js runs a Chromium
     instance per session (~350–500 MB each). Then set `OPENWA_MEM_LIMIT=4g`
     in `.env`.
2. When asked for an OS template, pick **Ubuntu 24.04** (plain) or Hostinger's
   **"Ubuntu with Docker"** template — the deploy script installs Docker
   automatically if it's missing, so either works.
3. Set the root password / add your SSH key (hPanel → VPS → **Settings → SSH keys**).
4. Note the VPS **public IPv4 address** (hPanel → VPS → Overview).

## 2. Point the domain at the VPS

In hPanel → **Domains → tachyel.com → DNS / Nameservers** add:

| Type | Name | Points to | TTL |
| --- | --- | --- | --- |
| A | `openwa` | `<VPS IPv4 address>` | 300 |

(If `tachyel.com` uses external DNS — e.g. Cloudflare — add the same A record
there. With Cloudflare, keep the record **DNS only / grey cloud** at least until
the first certificate is issued.)

Verify before continuing (propagation is usually < 5 min at TTL 300):

```bash
dig +short openwa.tachyel.com   # must print the VPS IP
```

Let's Encrypt issuance fails until this resolves to the VPS.

## 3. Deploy

SSH into the VPS and run:

```bash
ssh root@<VPS-IP>

git clone https://github.com/rohanx04/OpenWA.git /opt/openwa
cd /opt/openwa
bash scripts/deploy-hostinger.sh
```

The script:

1. installs Docker Engine + compose plugin if missing,
2. creates `.env` from `deploy/hostinger/.env.hostinger.example` and generates
   strong `API_MASTER_KEY` / `API_KEY_PEPPER` secrets,
3. checks that `openwa.tachyel.com` resolves to this server,
4. opens ports 80/443 in ufw (if ufw is active — Hostinger VPSes also have a
   panel firewall, see step 4 below),
5. builds the image and starts the stack
   (`docker-compose.yml` + the Hostinger TLS overlay),
6. waits for `/api/health/ready` and prints the dashboard URL + master key.

First build takes ~5–10 minutes (multi-stage image with Chromium). The Caddy
container then obtains the Let's Encrypt certificate automatically on the
first request — no certbot, no renewal cron.

## 4. Hostinger firewall

If you enabled a firewall in hPanel (VPS → **Settings → Firewall**), allow:

| Protocol | Port | Purpose |
| --- | --- | --- |
| TCP | 22 | SSH |
| TCP | 80 | HTTP (ACME challenge + redirect to HTTPS) |
| TCP | 443 | HTTPS |
| UDP | 443 | HTTP/3 (optional) |

Nothing else needs to be open — the API container is published on
`127.0.0.1:2785` only, and Postgres/Redis/MinIO (if enabled later) stay on the
internal Docker network.

## 5. Verify

```bash
curl -s https://openwa.tachyel.com/api/health/ready
```

Then open **https://openwa.tachyel.com** in a browser, log in to the dashboard
with the `API_MASTER_KEY` printed by the script (also stored in
`/opt/openwa/.env`), create a session, and scan the QR code with WhatsApp
(**Linked devices → Link a device**).

API example:

```bash
curl -H "X-Api-Key: <API_MASTER_KEY>" https://openwa.tachyel.com/api/sessions
```

## 6. Updating

```bash
cd /opt/openwa
git pull
bash scripts/deploy-hostinger.sh
```

Data survives redeploys — sessions, media, and the SQLite database live in the
`openwa_openwa-data` named volume, and TLS certificates in `openwa_caddy-data`.

### Optional: deploy from GitHub Actions

`.github/workflows/deploy-hostinger.yml` can run the same update over SSH from
the Actions tab. Add these repository secrets
(GitHub → Settings → Secrets and variables → Actions):

- `HOSTINGER_SSH_HOST` — the VPS IP
- `HOSTINGER_SSH_USER` — `root` (or your sudo user)
- `HOSTINGER_SSH_KEY` — a private key whose public half is in the VPS
  `~/.ssh/authorized_keys`
- `HOSTINGER_SSH_PORT` — optional, default 22

Then run **Actions → Deploy to Hostinger → Run workflow**. Uncomment the
`push: branches: [main]` trigger in the workflow to auto-deploy every push to
`main` once the secrets are in place.

## 7. Operations cheat-sheet

```bash
cd /opt/openwa
alias owa='docker compose -f docker-compose.yml -f deploy/hostinger/docker-compose.hostinger.yml'

owa ps                    # status
owa logs -f openwa-api    # API logs
owa logs -f caddy         # proxy / TLS logs
owa restart openwa-api    # restart the API
owa down                  # stop everything (volumes/data are kept)
bash scripts/backup.sh    # back up sessions + database (see script header)
```

### Troubleshooting

- **Browser shows a certificate error / Caddy logs ACME failures** — DNS is not
  pointing at the VPS yet, or port 80/443 is blocked by the hPanel firewall.
  Fix, then `owa restart caddy`.
- **502 from Caddy** — the API container is still starting or unhealthy:
  `owa logs openwa-api`. First boot writes its generated defaults (SQLite) to
  the data volume and can take ~30 s.
- **Session stuck at "authenticating" / QR times out** — see
  `docs/12-troubleshooting-faq.md` (`WWEBJS_WEB_VERSION`,
  `WWEBJS_AUTH_TIMEOUT_MS`); on a small VPS raise `WWEBJS_AUTH_TIMEOUT_MS`.
- **Out-of-memory kills with several sessions** — raise `OPENWA_MEM_LIMIT`
  (and the VPS plan), or switch the engine to Baileys in the dashboard
  (Infrastructure → Engine), which needs no Chromium.
