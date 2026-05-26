# PA Power Outage News Alert

Monitors Pennsylvania electricity/power outage news every 8 hours using an
**OpenAI + Tavily AI agent** inside an **n8n workflow**, and texts you an SMS
if a real outage story is found.

```
┌──────────────────────────────────────────────────────────────────────┐
│                    PA Power Outage News Alert                        │
│                                                                      │
│  ┌─────────────┐   ┌─────────────┐                                  │
│  │ Schedule    │   │  Webhook    │   (both trigger the same flow)   │
│  │ Every 8 hrs │   │  Manual     │                                  │
│  └──────┬──────┘   └──────┬──────┘                                  │
│         └────────┬─────────┘                                        │
│                  ▼                                                   │
│  ┌───────────────────────────────────────┐                          │
│  │  Search & Analyze (Code Node)         │                          │
│  │  1. GET prompt from localhost:3200    │                          │
│  │  2. POST query → Tavily (web search)  │                          │
│  │  3. POST results → OpenAI gpt-4o-mini │                          │
│  │  4. Parse: shouldAlert? summary? url? │                          │
│  └────────────────┬──────────────────────┘                          │
│                   ▼                                                  │
│          ┌────────────────┐                                         │
│          │ Should Alert?  │                                         │
│          └───┬────────┬───┘                                         │
│           YES│        │NO                                           │
│              ▼        ▼                                             │
│  ┌──────────────┐  ┌──────────┐                                     │
│  │ Send SMS     │  │ No-op    │                                     │
│  │ via Twilio   │  │          │                                     │
│  └──────────────┘  └──────────┘                                     │
│                                                                      │
│  ┌─────────────────────────────────────────────────────┐            │
│  │  Frontend  http://localhost:3200                    │            │
│  │  • Edit search prompt                               │            │
│  │  • View last run / last alert                       │            │
│  │  • "Run Now" manual trigger button                  │            │
│  └─────────────────────────────────────────────────────┘            │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Quick Start

### 1 — Install & start the frontend server

```bash
cd /Users/glennmossy/projects/news-alert
npm install

# Copy env template
cp .env.example .env
# (Twilio creds are optional for now — see step 4)

npm start
# → http://localhost:3200
```

### 2 — Import the workflow into n8n

1. Open n8n (usually `http://localhost:5678`)
2. **Workflows → Import from file** → select `workflow.json`
3. The workflow appears with 6 nodes pre-wired

### 3 — Configure n8n environment variables

In n8n go to **Settings → Environment Variables** and add:

| Variable | Value |
|---|---|
| `TWILIO_ACCOUNT_SID` | `ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx` |
| `TWILIO_AUTH_TOKEN`  | `your_auth_token` |
| `TWILIO_FROM_NUMBER` | `+1xxxxxxxxxx` (your Twilio number) |

> **Need Twilio?** Sign up free at https://twilio.com — the trial gives ~$15 credit,
> enough for hundreds of SMS alerts.

### 4 — Activate the workflow

Click the toggle at the top of the workflow in n8n to set it **Active**.
The schedule trigger starts counting from that moment.

### 5 — Edit the search prompt

Open **http://localhost:3200** in your browser to:
- Change the Tavily search prompt
- Change the SMS recipient number
- Hit **▶ Run Now** to test immediately (paste the Manual Trigger webhook URL first)

---

## How it works

| Step | What happens |
|---|---|
| Schedule fires | Every 8 hours (or manually via webhook) |
| Fetch config | Reads `config.json` from the local server (fallback: default prompt) |
| Tavily search | `search_depth: advanced`, up to 6 results, includes an overall answer |
| OpenAI analysis | `gpt-4o-mini` judges if results are *current* (≤48 h) PA outage news |
| IF relevant | If `ALERT: YES` → continue; otherwise → done |
| SMS via Twilio | Sends to `+1XXXXXXXXXX` with summary + URL |
| Status update | POSTs to `http://localhost:3200/api/status` so the UI reflects last run |

---

## File structure

```
news-alert/
├── workflow.json     ← Import this into n8n
├── config.json       ← Prompt & status (auto-updated)
├── server.js         ← Express API + static file server
├── package.json
├── .env.example      ← Copy to .env, add Twilio creds
├── public/
│   └── index.html    ← Prompt editor frontend
└── README.md
```

---

## API endpoints (Express server)

| Method | Path | Description |
|---|---|---|
| `GET`  | `/api/config` | Returns current config (read by n8n workflow) |
| `PUT`  | `/api/config` | Update prompt / sms_to |
| `POST` | `/api/status` | Called by n8n after each run |
| `GET`  | `/api/status` | Returns last run info |
| `GET`  | `/` | Serves the frontend UI |

---

## Customising the alert

Edit the prompt in the UI or directly in `config.json`:

```json
{
  "prompt": "PECO power outage Philadelphia Pennsylvania emergency",
  "sms_to": "+1XXXXXXXXXX"
}
```

Suggested prompts:
- `Pennsylvania electricity power outage news today`
- `PECO power outage Philadelphia Pennsylvania`
- `PPL Electric Pennsylvania outage restoration update`
- `FirstEnergy Pennsylvania power grid failure news`
