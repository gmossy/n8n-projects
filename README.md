# PA Power Outage News Alert

A Dockerized monitoring service that watches for **PPL Electric** power outage
news across all 29 PPL service-area counties in central & eastern Pennsylvania,
verifies the data is current, and sends a WhatsApp alert via CallMeBot.

- 🔍 **Two parallel Tavily searches** every 8 hours (live data + news, today/yesterday only)
- 🔄 **Google News RSS fallback** when Tavily fails or hits quota (free, no API key)
- 🚫 **Previous-year filter** — never summarizes content from prior years
- 🤖 **OpenAI factual summarizer** that only uses literal snippet facts (no hallucinated dates/numbers)
- 📲 **WhatsApp delivery** via CallMeBot (free, no Twilio account needed)
- 🖥️ **One-page dashboard** at `localhost:3200` — all config & testing in a single browser frame

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  PA Power Outage News Alert                                                  │
│                                                                              │
│  ┌────────────────────┐         ┌─────────────────────────────────────────┐  │
│  │   n8n workflow     │         │  Frontend  (Express @ :3200)            │  │
│  │   (scheduled)      │◀────────┤  ─────────────────────────────────────  │  │
│  │   every 8 hours    │  reads  │  • Edit prompt + API keys (UI)          │  │
│  │   localhost:5678   │  config │  • Live status + diagnostics            │  │
│  └─────────┬──────────┘         │  • ▶ Run Now (bypasses n8n entirely)    │  │
│            │                    │  • 📲 Test WhatsApp                     │  │
│            │                    │  • 📜 Search history (JSONL)            │  │
│            ▼                    └─────────────────┬───────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────────────────┐    │
│  │ Search & Analyze Pipeline                                            │    │
│  │                                                                      │    │
│  │   ┌──────────────────────┐                                          │    │
│  │   │  Tavily (primary)    │  ◀─ 2 parallel calls:                    │    │
│  │   │  search_depth=adv    │      (A) LIVE DATA   poweroutage.us +    │    │
│  │   │  topic=news, days=1  │          omap.prod.pplweb.com + pplweb   │    │
│  │   │  include_domains[27] │      (B) FRESH NEWS  27 PA news domains  │    │
│  │   └──────────┬───────────┘                                          │    │
│  │              │ on quota/network failure                             │    │
│  │              ▼                                                       │    │
│  │   ┌──────────────────────┐                                          │    │
│  │   │ Google News RSS      │  9 parallel queries, one per PPL region: │    │
│  │   │ (free fallback)      │  general · lehigh_valley · poconos ·     │    │
│  │   │ + canonical          │  nepa · central_pa · lancaster_york ·    │    │
│  │   │   PowerOutage links  │  berks_schuylkill · north_central ·      │    │
│  │   └──────────┬───────────┘  chester                                  │    │
│  │              ▼                                                       │    │
│  │   ┌──────────────────────┐                                          │    │
│  │   │  Filters & classify  │  • Drop sources from previous years      │    │
│  │   │                      │  • Tag currency: live/today/yesterday/   │    │
│  │   │                      │    older/undated                         │    │
│  │   │                      │  • Feed only confirmed-current to LLM    │    │
│  │   └──────────┬───────────┘                                          │    │
│  │              ▼                                                       │    │
│  │   ┌──────────────────────┐                                          │    │
│  │   │  OpenAI gpt-4o-mini  │  Strict prompt: only literal snippet     │    │
│  │   │  (factual summarizer)│  facts. Replies NO_CURRENT_OUTAGE if no  │    │
│  │   │                      │  significant data exists.                │    │
│  │   └──────────┬───────────┘                                          │    │
│  │              ▼                                                       │    │
│  │   ┌──────────────────────┐                                          │    │
│  │   │  CallMeBot WhatsApp  │  Sends ⚡ alert or ℹ️ "no current        │    │
│  │   │                      │  outage" message — always honest.        │    │
│  │   │                      │  Includes article URL + county-specific  │    │
│  │   │                      │  live link + PowerOutage.us dashboard.   │    │
│  │   └──────────────────────┘                                          │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Quick Start

### Prerequisites

- Docker Desktop running
- Three free API keys:
  - **OpenAI** — https://platform.openai.com/api-keys
  - **Tavily** — https://app.tavily.com (1,000 free searches/month)
  - **CallMeBot** — see step 3 below (totally free)

### 1 — Clone & start

```bash
git clone https://github.com/gmossy/n8n-projects.git -b ppl-power-news-alert news-alert
cd news-alert
cp config.example.json config.json   # template — you'll fill in keys via the UI
docker compose up -d
```

Three containers come up:

| Service     | Port | Purpose                                          |
|-------------|------|--------------------------------------------------|
| `frontend`  | 3200 | Express dashboard + config API                   |
| `n8n`       | 5678 | Scheduled workflow engine                        |
| `n8n-import`|  —   | One-shot: imports `workflow.json` on first boot  |

### 2 — Open the dashboard

http://localhost:3200

You'll see a two-column layout:

- **Left column:** Search Settings (prompt + WhatsApp # + OpenAI model) and API Credentials (OpenAI / Tavily / CallMeBot keys)
- **Right column:** Last Run Status and System Status & Testing

Fill in your API keys → **Save All Settings**.

### 3 — Set up free WhatsApp (CallMeBot)

1. Save **+34 623 78 64 49** as a contact on your phone
2. Send it the exact message: `I allow callmebot to send me messages`
3. They reply with an API key (a 7-digit number) — paste it into the **CallMeBot API Key** field
4. Hit the inline **📲 Test** button to verify

### 4 — Activate the scheduled workflow (optional — only for the every-8-hours job)

In the **System Status & Testing** card, click **Activate** next to "Scheduled workflow (every 8h)." The frontend calls n8n's REST API and flips the toggle for you. (If n8n requires an API key, it falls back to a one-click link to localhost:5678.)

**Note:** the manual ▶ Run Now button doesn't need this — it bypasses n8n entirely.

### 5 — Run it

Click **▶ Run Now**. You'll see a live step-by-step progress UI:

```
✅ Config saved
✅ Found 8 results (🔴 4 live · 📰 4 fresh news)
✅ Summary generated
✅ WhatsApp sent — check your phone
```

The result panel below shows every source with a colored currency badge:
🔴 LIVE · ✓ TODAY · ✓ YESTERDAY · ⚠ OLDER · ? UNDATED.

---

## What gets sent to your WhatsApp

**When current outage is detected:**

```
⚡ PA Power Alert!
PPL is restoring power to 12,000 customers in Lehigh County after high winds.

📰 https://www.wfmz.com/news/article/...
📍 Lehigh County live: https://poweroutage.us/area/county/lehigh
🚨 Live PA outage alerts: https://poweroutage.us/dashboard/alerts
```

**When no current outage:**

```
ℹ️ TEST — No current outage in results
Prompt: PPL Electric outage Pennsylvania today

Live PowerOutage.us shows <100 customers out and no PA outage news in the last 2 days.

🚨 Live PA outage alerts: https://poweroutage.us/dashboard/alerts
```

Every message includes the **PowerOutage.us live dashboard link** so you can verify real-time numbers yourself.

---

## How the data is verified current

Two complementary tracks run on every search:

| Track | Source | How "current" is enforced |
|-------|--------|----------------------------|
| 🔴 **LIVE DATA** | `poweroutage.us`, `omap.prod.pplweb.com`, `pplweb.com` | These pages are always-current by definition — they display real-time customer-out counts. |
| 📰 **FRESH NEWS** | 27 PA news domains covering all 29 PPL counties | Tavily filter `topic: news, days: 1` returns only articles published today or yesterday. |

**Hard filters applied after the search:**
1. Any article whose `published_date.year < currentYear` is **dropped at ingestion** — never seen by OpenAI, never sent to WhatsApp.
2. Only results with currency `live`, `today`, or `yesterday` are passed to the LLM. `older` / `undated` news is shown in the UI source list (so you can see what was excluded) but not summarized.

**OpenAI prompt is strict:**
- Today's date is injected as a known fact.
- Model is told: "ONLY report facts that appear LITERALLY in the snippet text."
- Cannot invent numbers, counties, dates, or causes.
- Must respond `NO_CURRENT_OUTAGE: …` if data is insufficient.

---

## PPL service area coverage (29 counties)

The system auto-augments prompts that don't already mention a PPL county. The 27-domain Tavily allowlist + 9-region Google News fallback collectively cover:

| Region | Counties | News domains used |
|--------|----------|-------------------|
| Lehigh Valley | Lehigh, Northampton | wfmz.com, lehighvalleylive.com, mcall.com |
| Poconos | Monroe, Pike, Wayne, Carbon | pocononewstoday.com, pocono-record.com |
| NEPA / Scranton / Wilkes-Barre | Lackawanna, Luzerne, Wyoming, Susquehanna | wnep.com, citizensvoice.com, thetimes-tribune.com, timesleader.com, standardspeaker.com |
| Harrisburg / Central PA | Dauphin, Cumberland, Lebanon | pennlive.com, wgal.com, abc27.com, fox43.com |
| Lancaster / York / Adams | Lancaster, York, Adams | lancasteronline.com, ydr.com, gettysburgtimes.com |
| Berks / Schuylkill | Berks, Schuylkill | readingeagle.com, republicanherald.com |
| North Central | Lycoming, Bradford, Sullivan, Columbia, Montour, Northumberland, Snyder, Union, Centre, Clinton | pressenterpriseonline.com, dailyitem.com, sungazette.com, pahomepage.com |
| Chester | Chester | dailylocal.com |
| All PPL | (utility-wide) | pplweb.com, omap.prod.pplweb.com, poweroutage.us |

---

## File structure

```
news-alert/
├── docker-compose.yml          ← 3 services: frontend, n8n, n8n-import
├── Dockerfile                  ← Node 20 Alpine for the frontend
├── server.js                   ← Express API + Tavily + OpenAI + CallMeBot
├── package.json
├── workflow.json               ← Imported into n8n on first boot
├── workflow-test-whatsapp.json ← Separate n8n test workflow
├── public/
│   └── index.html              ← Single-page dashboard (no build step)
├── logs/
│   ├── .gitkeep
│   └── search-log.jsonl        ← Persistent search history (bind-mounted)
├── config.example.json         ← Template — copy to config.json
├── config.json                 ← Your live config (gitignored — holds API keys)
└── .env.example                ← Optional env vars
```

---

## API endpoints (Express server)

| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/api/config` | Returns current config (n8n + frontend both read this) |
| `PUT`  | `/api/config` | Update prompt, keys, recipient number |
| `POST` | `/api/status` | Called by n8n after each run to update last-run state |
| `GET`  | `/api/status` | Returns last run summary |
| `GET`  | `/api/n8n-status` | Probes n8n + checks if scheduled workflow is active |
| `POST` | `/api/activate-workflow` | Auto-activates the workflow via n8n REST API |
| `POST` | `/api/test-whatsapp` | Sends a static test message via CallMeBot |
| `POST` | `/api/test-full-run` | Full pipeline: Tavily → OpenAI → CallMeBot → log entry |
| `GET`  | `/api/logs` | Returns recent search-run history (JSONL, newest first) |
| `DELETE`| `/api/logs` | Clears all logs |

---

## Search logging

Every Run Now (and every scheduled run that calls `/api/status`) is persisted to `logs/search-log.jsonl` on the host. View it three ways:

```bash
# Raw file on host
cat logs/search-log.jsonl | jq 'select(.outcome=="alert_sent")'

# Via REST API
curl http://localhost:3200/api/logs?limit=20

# In the UI
# Open localhost:3200 → expand 📜 Recent searches at the bottom of the testing card
```

Each entry includes timestamp, prompt, outcome (`alert_sent` / `no_current_outage` / `no_results` / `tavily_error` / `whatsapp_error`), summary, every source with its currency tag, WhatsApp delivery status, and whether the Google News fallback was triggered.

Log is auto-trimmed to the last 200 entries.

---

## Stopping & restarting

```bash
docker compose logs -f         # tail all service logs
docker compose down            # stop (keeps n8n volume + config + logs)
docker compose down -v         # stop + wipe n8n's data volume
docker compose up -d           # restart everything
```

`config.json` and `logs/` are bind-mounted to the host, so they survive container rebuilds.

---

## Troubleshooting

**Tavily returns "usage limit exceeded"**
You hit the 1,000/month free tier. The system automatically falls back to Google News RSS (free, unlimited) + canonical PowerOutage.us links. A yellow banner in the result panel confirms when fallback is active.

**WhatsApp "Test" button works but Run Now doesn't send a message**
Check that all three API keys (OpenAI, Tavily, CallMeBot) are saved. The diagnostics row "API keys" turns green when all are set.

**Scheduled workflow row says "Inactive"**
Click **Activate** in that row. If n8n's API requires authentication in your setup, the button switches to "Open n8n ↗" — click it and flip the toggle manually at localhost:5678.

**WhatsApp message arrives but content looks wrong/old**
Check the source list in the result panel — every source has a currency badge. If you see `⚠ OLDER` items, those were excluded from the summary but visible for transparency. The `🚫 Dropped N previous-year result(s)` note tells you how many were filtered out entirely.

---

## License

MIT — do whatever you want with it.
