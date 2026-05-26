require('dotenv').config()
const express = require('express')
const cors    = require('cors')
const fs      = require('fs')
const path    = require('path')

const app        = express()
const PORT       = process.env.PORT || 3200
const CONFIG_PATH = path.join(__dirname, 'config.json')
const LOG_DIR    = path.join(__dirname, 'logs')
const LOG_PATH   = path.join(LOG_DIR, 'search-log.jsonl')
const MAX_LOG_LINES = 200    // keep last N searches

// Ensure log dir exists (no-op if bind-mounted)
try { fs.mkdirSync(LOG_DIR, { recursive: true }) } catch {}

function appendLog (entry) {
  try {
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n'
    fs.appendFileSync(LOG_PATH, line, 'utf8')
    // Trim to last MAX_LOG_LINES
    const lines = fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean)
    if (lines.length > MAX_LOG_LINES) {
      fs.writeFileSync(LOG_PATH, lines.slice(-MAX_LOG_LINES).join('\n') + '\n', 'utf8')
    }
    console.log(`[search-log] ${entry.outcome || 'logged'} — prompt: "${(entry.prompt||'').substring(0,60)}" — sources: ${entry.sources?.length || 0}`)
  } catch (e) {
    console.error('Log write failed:', e.message)
  }
}

// ── Fallback: Google News RSS (free, no API key) ─────────────────────────
// Runs multiple parallel queries covering each PPL service region, dedupes,
// and returns Tavily-shaped results. Triggered when Tavily fails or hits quota.

// One query per PPL region. Each appends region-specific terms so Google News
// surfaces stories from that region's local press.
const PPL_REGION_QUERIES = [
  { region: 'lehigh_valley',  terms: 'Lehigh Valley Allentown Bethlehem Easton Northampton' },
  { region: 'poconos',        terms: 'Poconos Monroe Pike Wayne Carbon county' },
  { region: 'nepa',           terms: 'Scranton Wilkes-Barre Hazleton Lackawanna Luzerne Susquehanna Wyoming' },
  { region: 'central_pa',     terms: 'Harrisburg Dauphin Cumberland Lebanon central Pennsylvania' },
  { region: 'lancaster_york', terms: 'Lancaster York Adams county Pennsylvania' },
  { region: 'berks_schuylkill', terms: 'Berks Reading Schuylkill Pottsville Pennsylvania' },
  { region: 'north_central',  terms: 'Williamsport Lycoming Bradford Sullivan Columbia Montour Northumberland Snyder Union' },
  { region: 'chester',        terms: 'Chester county Pennsylvania' }
]

async function fetchGoogleNewsRss (query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 PA-Power-Alert/1.0' } })
    if (!r.ok) return { results: [], error: `HTTP ${r.status}` }
    const xml = await r.text()
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 10)
    const decode = s => (s || '')
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'")
    const pick = (block, tag) => decode((block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`)) || [])[1])
    const results = items.map(m => {
      const block = m[1]
      const title = pick(block, 'title')
      const link  = pick(block, 'link')
      const pub   = pick(block, 'pubDate')
      const desc  = pick(block, 'description').replace(/<[^>]+>/g, '').substring(0, 500)
      const isoDate = pub ? new Date(pub).toISOString() : null
      return { title, url: link, content: desc, published_date: isoDate }
    }).filter(r => r.title && r.url)
    return { results }
  } catch (e) {
    return { results: [], error: e.message }
  }
}

async function googleNewsFallback (basePrompt) {
  // Run one general query + one per PPL region in parallel
  const queries = [
    { region: 'general', terms: '' },
    ...PPL_REGION_QUERIES
  ].map(q => ({
    region: q.region,
    query: q.terms
      ? `${basePrompt} ${q.terms} power outage`.replace(/\s+/g, ' ').trim()
      : `${basePrompt} power outage`.replace(/\s+/g, ' ').trim()
  }))

  const batches = await Promise.all(queries.map(async q => {
    const r = await fetchGoogleNewsRss(q.query)
    return r.results.map(item => ({ ...item, _region: q.region }))
  }))

  // Flatten + dedupe by URL (Google News URLs are unique per article)
  const seen = new Map()
  for (const arr of batches) {
    for (const item of arr) {
      if (!seen.has(item.url)) seen.set(item.url, item)
    }
  }
  const merged = [...seen.values()]

  // Sort newest first (items without dates go to the end)
  merged.sort((a, b) => {
    const da = a.published_date ? Date.parse(a.published_date) : 0
    const db = b.published_date ? Date.parse(b.published_date) : 0
    return db - da
  })

  // Cap to top 15 to keep prompt size reasonable
  const top = merged.slice(0, 15)

  // Region coverage for the log
  const regionCounts = top.reduce((acc, r) => { acc[r._region] = (acc[r._region]||0) + 1; return acc }, {})

  return {
    results: top,
    answer: '',
    _fallback: 'google_news_rss_multi',
    _regionCounts: regionCounts,
    _queriesRun: queries.length
  }
}

function readLogs (limit = 50) {
  try {
    const lines = fs.readFileSync(LOG_PATH, 'utf8').split('\n').filter(Boolean)
    return lines.slice(-limit).reverse().map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}

app.use(cors())
app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

/* ── helpers ── */
function readConfig () {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    return {
      prompt: 'Pennsylvania electricity power outage news today',
      sms_to: '+1XXXXXXXXXX',
      schedule_hours: 8,
      last_run: null,
      last_run_status: null,
      last_alert_sent: null,
      last_summary: null,
      last_url: null,
      updated_at: new Date().toISOString()
    }
  }
}

function writeConfig (data) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf8')
}

/* ── routes ── */

// GET current config (n8n + frontend read this)
app.get('/api/config', (req, res) => {
  res.json(readConfig())
})

// PUT update config (frontend saves new prompt)
app.put('/api/config', (req, res) => {
  const current = readConfig()
  const allowed = ['prompt', 'sms_to', 'schedule_hours', 'openai_apikey', 'openai_model', 'tavily_apikey', 'callmebot_phone', 'callmebot_apikey']
  const updates = {}
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key]
  }
  if (!updates.prompt || !String(updates.prompt).trim()) {
    return res.status(400).json({ error: 'prompt is required' })
  }
  const next = { ...current, ...updates, updated_at: new Date().toISOString() }
  writeConfig(next)
  res.json({ ok: true, config: next })
})

// POST update run status (called by n8n workflow after each run)
app.post('/api/status', (req, res) => {
  const current  = readConfig()
  const { sent, summary, url, error } = req.body
  const next = {
    ...current,
    last_run:        new Date().toISOString(),
    last_run_status: sent ? 'alert_sent' : (error ? 'error' : 'no_news'),
    last_alert_sent: sent ? new Date().toISOString() : current.last_alert_sent,
    last_summary:    summary  || current.last_summary,
    last_url:        url      || current.last_url
  }
  writeConfig(next)
  res.json({ ok: true })
})

// GET recent search-run logs (newest first)
app.get('/api/logs', (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 50
  res.json({ logs: readLogs(limit), total: readLogs(MAX_LOG_LINES).length })
})

// DELETE all logs
app.delete('/api/logs', (req, res) => {
  try { fs.writeFileSync(LOG_PATH, '', 'utf8'); res.json({ ok: true }) }
  catch (e) { res.status(500).json({ ok: false, error: e.message }) }
})

// GET run history (last status only — full history lives in n8n)
app.get('/api/status', (req, res) => {
  const cfg = readConfig()
  res.json({
    last_run:        cfg.last_run,
    last_run_status: cfg.last_run_status,
    last_alert_sent: cfg.last_alert_sent,
    last_summary:    cfg.last_summary,
    last_url:        cfg.last_url
  })
})

// POST full test run — real Tavily search + OpenAI summary → always sends to WhatsApp
app.post('/api/test-full-run', async (req, res) => {
  const cfg = readConfig()

  if (!cfg.tavily_apikey)   return res.status(400).json({ ok: false, step: 'config', error: 'Tavily API key not set — add it at http://localhost:3200' })
  if (!cfg.openai_apikey)   return res.status(400).json({ ok: false, step: 'config', error: 'OpenAI API key not set — add it at http://localhost:3200' })
  if (!cfg.callmebot_apikey) return res.status(400).json({ ok: false, step: 'config', error: 'CallMeBot API key not set — add it at http://localhost:3200' })

  const rawPrompt = (cfg.prompt || 'PPL Electric outage Pennsylvania today').trim()

  // ── Auto-augment prompt with PPL service-area context if missing ────────
  // PPL Electric serves 29 counties across central & eastern Pennsylvania.
  const PPL_COUNTIES = [
    'Adams','Berks','Bradford','Carbon','Centre','Chester','Clinton','Columbia',
    'Cumberland','Dauphin','Lackawanna','Lancaster','Lebanon','Lehigh','Luzerne',
    'Lycoming','Monroe','Montgomery','Montour','Northampton','Northumberland',
    'Pike','Schuylkill','Snyder','Sullivan','Susquehanna','Union','Wayne',
    'Wyoming','York'
  ]
  const promptLower = rawPrompt.toLowerCase()
  const hasCounty   = PPL_COUNTIES.some(c => promptLower.includes(c.toLowerCase()))
  const hasPPL      = /\bppl\b/i.test(rawPrompt)
  // If prompt doesn't already mention PPL or a specific county, append context
  const prompt = (hasPPL && hasCounty)
    ? rawPrompt
    : `${rawPrompt} ${!hasPPL ? 'PPL Electric Utilities' : ''} ${!hasCounty ? '(Lehigh Northampton Monroe Carbon Pike Wayne Lackawanna Luzerne Dauphin Lancaster York Berks Schuylkill counties Pennsylvania)' : ''}`.trim()

  // ── Step 1: Two parallel Tavily searches ─────────────────────────────────
  //   (A) LIVE DATA — PowerOutage.us + PPL outage map (general topic, always-current pages)
  //   (B) FRESH NEWS — only articles from today + yesterday (topic:news, days:2)
  const LIVE_DOMAINS = ['poweroutage.us', 'omap.prod.pplweb.com', 'pplweb.com']
  const NEWS_DOMAINS = [
    'wfmz.com','lehighvalleylive.com','mcall.com',
    'pocononewstoday.com','pocono-record.com',
    'wnep.com','citizensvoice.com','thetimes-tribune.com','timesleader.com','standardspeaker.com',
    'pennlive.com','wgal.com','abc27.com','fox43.com',
    'lancasteronline.com','ydr.com','gettysburgtimes.com',
    'readingeagle.com','republicanherald.com',
    'pressenterpriseonline.com','dailyitem.com',
    'sungazette.com','pahomepage.com',
    'dailylocal.com'
  ]

  const tavilyCall = (body) => fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${cfg.tavily_apikey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(async r => {
    const data = await r.json()
    if (data.detail?.error) return { _apiError: data.detail.error, results: [] }
    return data
  }).catch(e => ({ _apiError: e.message, results: [] }))

  let results = [], answer = '', liveCount = 0, newsCount = 0, usedFallback = false, fallbackNote = ''
  try {
    const [liveData, newsData] = await Promise.all([
      tavilyCall({
        query: prompt,
        search_depth: 'advanced',
        max_results: 4,
        include_answer: true,
        include_domains: LIVE_DOMAINS
      }),
      tavilyCall({
        query: prompt,
        search_depth: 'advanced',
        max_results: 8,
        include_answer: true,
        topic: 'news',
        days: 1,                // last 24h — Tavily returns today + yesterday
        include_domains: NEWS_DOMAINS
      })
    ])
    // Tag each result with a currency label: live / today / yesterday / older
    const todayStr     = new Date().toISOString().slice(0,10)
    const yesterdayStr = new Date(Date.now() - 86400000).toISOString().slice(0,10)
    const classifyDate = (iso) => {
      if (!iso) return 'undated'
      const d = iso.slice(0,10)
      if (d === todayStr)     return 'today'
      if (d === yesterdayStr) return 'yesterday'
      return 'older'
    }
    // If Tavily errored (quota, auth, network), fall back to Google News RSS (free, no key)
    const apiErr = liveData._apiError || newsData._apiError
    if (apiErr) {
      const isQuota = /usage limit|plan|upgrade|quota/i.test(apiErr)
      console.warn(`[fallback] Tavily failed (${apiErr.substring(0,80)}) — switching to Google News RSS`)
      const fbRes = await googleNewsFallback(prompt)
      if (fbRes.results.length === 0) {
        const errMsg = (isQuota ? '⚠️ Tavily quota exceeded ' : 'Tavily error ') +
          `AND Google News fallback returned nothing. Raw: ${apiErr.substring(0,120)} / ${fbRes._fallbackError || 'empty'}`
        appendLog({ outcome: 'tavily_error', prompt, error: errMsg })
        return res.status(502).json({ ok: false, step: 'tavily', error: errMsg })
      }
      // Map fallback results into our shape (treat as news with publish dates)
      newsData.results = fbRes.results
      newsData.answer  = fbRes.answer
      // Even without Tavily, ALWAYS surface the canonical PowerOutage.us / PPL outage map
      // links as live sources so the user can click through to verify real-time data.
      liveData.results = [
        {
          title: 'Pennsylvania Statewide Outage Map (Live)',
          url:   'https://poweroutage.us/area/state/pennsylvania',
          content: 'Real-time customer outage counts across all Pennsylvania utilities including PPL Electric. Click to view current numbers.',
          published_date: null
        },
        {
          title: 'PPL Electric Utilities Outages (Live)',
          url:   'https://poweroutage.us/area/utility/125',
          content: 'Real-time PPL Electric customer-out count, updated continuously.',
          published_date: null
        },
        {
          title: 'PPL Electric Outage Map (Official)',
          url:   'https://omap.prod.pplweb.com/omap',
          content: 'PPL\'s own outage map — search by address, see repair status and estimated restoration times.',
          published_date: null
        },
        {
          title: 'PowerOutage.us Live Alerts Dashboard',
          url:   'https://poweroutage.us/dashboard/alerts',
          content: 'Active major outage events across the United States in real time.',
          published_date: null
        }
      ]
      usedFallback = true
      const regionsHit = Object.keys(fbRes._regionCounts || {}).length
      const totalQueries = fbRes._queriesRun || 0
      fallbackNote = (isQuota ? '🔄 Tavily quota exceeded — ' : '🔄 Tavily error — ') +
        `using ${totalQueries}-region Google News RSS fallback (${fbRes.results.length} unique articles across ${regionsHit} regions) + canonical PowerOutage.us links.`
    }
    // HARD FILTER: drop any news result from a previous calendar year
    const currentYear = new Date().getUTCFullYear()
    const isFromPreviousYear = (iso) => {
      if (!iso) return false           // undated → keep (live pages have no date)
      const y = new Date(iso).getUTCFullYear()
      return Number.isFinite(y) && y < currentYear
    }
    let droppedPreviousYear = 0
    const liveResults = (liveData.results || []).map(r => ({ ...r, _source: 'live', _currency: 'live' }))
    const newsResultsRaw = (newsData.results || []).map(r => ({ ...r, _source: 'news', _currency: classifyDate(r.published_date) }))
    const newsResults = newsResultsRaw.filter(r => {
      if (isFromPreviousYear(r.published_date)) { droppedPreviousYear++; return false }
      return true
    })
    liveCount = liveResults.length
    newsCount = newsResults.length
    results = [...liveResults, ...newsResults]  // live first
    answer  = newsData.answer || liveData.answer || ''
    if (droppedPreviousYear > 0) {
      console.log(`[filter] Dropped ${droppedPreviousYear} result(s) from a previous calendar year`)
      fallbackNote = (fallbackNote ? fallbackNote + ' ' : '') + `🚫 Dropped ${droppedPreviousYear} previous-year result(s).`
    }
  } catch (e) {
    return res.status(502).json({ ok: false, step: 'tavily', error: 'Tavily search failed: ' + e.message })
  }

  if (results.length === 0) {
    const errMsg = `No results from the current year for "${prompt.substring(0,60)}". (Live data empty, news filtered to ${new Date().getUTCFullYear()}+ only.)`
    appendLog({ outcome: 'no_results', prompt, error: errMsg, usedFallback })
    return res.status(200).json({ ok: false, step: 'tavily', error: errMsg, usedFallback, fallbackNote })
  }

  // ── Step 2: OpenAI summary ───────────────────────────────────────────────
  let summary = '', topUrl = results[0]?.url || ''
  try {
    // Feed OpenAI ONLY confirmed-current results (live, today, yesterday).
    // Anything older or undated-news is excluded — but still shown to the user in the source list.
    const llmResults = results.filter(r => ['live','today','yesterday'].includes(r._currency))
    if (llmResults.length === 0) {
      summary = 'NO_CURRENT_OUTAGE: No confirmed-current sources (no live data and no news from today/yesterday) for this prompt.'
    }
    const resultsText = llmResults.map((r, i) => {
      const tag = r._currency === 'live' ? '🔴 LIVE DATA' : (r._currency === 'today' ? '✓ TODAY' : '✓ YESTERDAY')
      return `[${i+1}] ${tag} — ${r.title}\nURL: ${r.url}\nPUBLISHED: ${r.published_date || '(undated — always-current live page)'}\nSNIPPET: ${(r.content||'').substring(0, 500)}`
    }).join('\n\n---\n\n')

    const now       = new Date()
    const today     = now.toISOString().slice(0,10)
    const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0,10)

    const sysPrompt = `You are a factual real-time outage reporter for PPL Electric in Pennsylvania.
Today's date is ${today}. Yesterday was ${yesterday}.
${usedFallback ? `\nNOTE: Tavily search is unavailable — using Google News RSS fallback. The LIVE DATA entries below are canonical reference links (no scraped numbers); direct readers to click them to verify real-time customer counts.\n` : ''}
The search you are reviewing was filtered to ONLY return:
  (A) 🔴 LIVE DATA from poweroutage.us / PPL outage map (always-current pages)
  (B) 📰 FRESH NEWS articles published on ${today} or ${yesterday}
Both are confirmed-current. Articles you see are NOT historical.

PRIORITY ORDER:
1. 🔴 LIVE DATA — extract the literal "X Customers Out" number from the snippet. This is the ground truth.
2. 📰 FRESH NEWS — describe the specific incident in the article (customers affected, county, cause).

STRICT RULES:
A. ONLY report facts that appear LITERALLY in the snippet text. Never invent numbers, counties, or causes.
B. If a PUBLISHED date is provided, you MAY say "as of <that date>". Never invent dates.
C. If LIVE DATA shows < 100 customers out AND no fresh-news incident → respond EXACTLY:
   NO_CURRENT_OUTAGE: Live PowerOutage.us shows <N> customers out and no PA outage news in the last 2 days.
D. Otherwise, lead with the most significant fact: highest customer-count or most recent news incident.
E. Max 200 chars for the summary, then the URL on its own line.`

    // Only call OpenAI if there's confirmed-current material to summarize
    if (llmResults.length > 0) {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${cfg.openai_apikey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: cfg.openai_model || 'gpt-4o-mini',
          messages: [
            { role: 'system', content: sysPrompt },
            { role: 'user', content: `Search query: "${prompt}"\nTavily one-line answer: ${answer}\n\nResults:\n${resultsText}` }
          ],
          max_tokens: 250, temperature: 0
        })
      })
      const data = await r.json()
      const raw  = data.choices?.[0]?.message?.content?.trim() || ''
      const urlM = raw.match(/https?:\/\/\S+/)
      summary    = raw.replace(/https?:\/\/\S+/, '').trim() || answer || llmResults[0]?.title || 'Search completed'
      topUrl     = urlM ? urlM[0] : (llmResults[0]?.url || topUrl)
    } else {
      topUrl = 'https://poweroutage.us/dashboard/alerts'
    }
  } catch (e) {
    summary = answer || results[0]?.title || 'Search completed'
  }

  // Detect honest "no current outage" response from the LLM
  const noCurrent = /NO_CURRENT_OUTAGE|no significant outage|no current outage|no live outage data/i.test(summary)
  summary = summary.replace(/NO_CURRENT_OUTAGE:\s*/i, '').trim()

  // ── Detect a PPL county mentioned in the summary for a deep-link ─────────
  const mentioned = PPL_COUNTIES.find(c => new RegExp(`\\b${c}\\b`, 'i').test(summary))
  const liveAlerts = 'https://poweroutage.us/dashboard/alerts'
  const countyLink = mentioned ? `https://poweroutage.us/area/county/${mentioned.toLowerCase()}` : null

  // ── Step 3: Always send to WhatsApp (force send for test) ────────────────
  const header = noCurrent ? 'ℹ️ TEST — No current outage in results' : '🔍 TEST RESULT'
  const waText = encodeURIComponent(
    `${header}\nPrompt: ${prompt.substring(0,80)}\n\n${summary}\n\n📰 ${topUrl}${countyLink ? `\n📍 ${mentioned} County live: ${countyLink}` : ''}\n🚨 Live PA outage alerts: ${liveAlerts}`.substring(0, 1500)
  )
  const waUrl = `https://api.callmebot.com/whatsapp.php?phone=${cfg.callmebot_phone}&text=${waText}&apikey=${cfg.callmebot_apikey}`

  try {
    const https = require('https')
    const waBody = await new Promise((resolve, reject) => {
      https.get(waUrl, r => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(d)) }).on('error', reject)
    })
    if (waBody.toLowerCase().includes('error')) {
      appendLog({ outcome: 'whatsapp_error', prompt, summary, topUrl, error: waBody.substring(0,200), resultCount: results.length })
      return res.json({ ok: false, step: 'whatsapp', error: waBody.substring(0, 200), summary, topUrl, resultCount: results.length })
    }

    // Compact per-result list for the frontend to display & user-verify
    const sources = results.map(r => ({
      title:    (r.title || '').substring(0, 140),
      url:      r.url,
      domain:   (() => { try { return new URL(r.url).hostname.replace(/^www\./,'') } catch { return '' } })(),
      currency: r._currency,            // 'live' | 'today' | 'yesterday' | 'older' | 'undated'
      source:   r._source,              // 'live' | 'news'
      region:   r._region || null,      // for fallback results: which PPL region query found it
      publishedDate: r.published_date || null
    }))
    appendLog({
      outcome: noCurrent ? 'no_current_outage' : 'alert_sent',
      prompt,
      summary,
      topUrl,
      resultCount: results.length,
      liveCount, newsCount,
      county: mentioned,
      whatsappSent: true,
      usedFallback,
      sources    // includes per-result currency tags
    })
    res.json({ ok: true, message: 'Full test done — check your WhatsApp!', prompt, summary, topUrl, resultCount: results.length, liveCount, newsCount, sources, liveAlerts, county: mentioned, countyLink, noCurrent, usedFallback, fallbackNote })
  } catch (e) {
    res.status(502).json({ ok: false, step: 'whatsapp', error: 'WhatsApp send failed: ' + e.message, summary, topUrl })
  }
})

// POST send a test WhatsApp message via CallMeBot
app.post('/api/test-whatsapp', async (req, res) => {
  const cfg    = readConfig()
  const phone  = cfg.callmebot_phone  || ''
  const apiKey = cfg.callmebot_apikey || ''

  if (!phone || !apiKey) {
    return res.status(400).json({ ok: false, error: 'callmebot_phone or callmebot_apikey not set in config' })
  }

  const message    = encodeURIComponent('✅ Test from PA Power Alert — WhatsApp notifications are working!')
  const url        = `https://api.callmebot.com/whatsapp.php?phone=${phone}&text=${message}&apikey=${apiKey}`

  try {
    const https = require('https')
    const body  = await new Promise((resolve, reject) => {
      https.get(url, r => {
        let d = ''
        r.on('data', c => d += c)
        r.on('end', () => resolve(d))
      }).on('error', reject)
    })
    if (body.toLowerCase().includes('error')) {
      return res.status(502).json({ ok: false, error: body.substring(0, 300) })
    }
    res.json({ ok: true, message: 'Test WhatsApp sent! Check your phone.' })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// GET n8n health + workflow active status
app.get('/api/n8n-status', async (req, res) => {
  const bases = ['http://n8n:5678', 'http://localhost:5678']
  let n8nUp = false, n8nBase = ''

  for (const base of bases) {
    try {
      const r = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(3000) })
      if (r.ok) { n8nUp = true; n8nBase = base; break }
    } catch {}
  }

  if (!n8nUp) return res.json({ n8nUp: false, workflowActive: false, workflowId: null, apiError: null })

  // Try n8n REST API (works when N8N_USER_MANAGEMENT_DISABLED=true)
  try {
    const r = await fetch(`${n8nBase}/api/v1/workflows`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(4000)
    })
    if (r.ok) {
      const data = await r.json()
      const wf = (data.data || []).find(w => w.name === 'PA Power Outage News Alert')
      return res.json({ n8nUp: true, workflowActive: wf?.active || false, workflowId: wf?.id || null, apiError: null })
    }
    // API returned non-200 (probably needs auth)
    const errText = await r.text()
    return res.json({ n8nUp: true, workflowActive: null, workflowId: null, apiError: `n8n API returned ${r.status} — ${errText.substring(0,80)}` })
  } catch (e) {
    return res.json({ n8nUp: true, workflowActive: null, workflowId: null, apiError: e.message })
  }
})

// POST activate the workflow via n8n REST API
app.post('/api/activate-workflow', async (req, res) => {
  const bases = ['http://n8n:5678', 'http://localhost:5678']
  let n8nBase = ''
  for (const base of bases) {
    try {
      const r = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(3000) })
      if (r.ok) { n8nBase = base; break }
    } catch {}
  }
  if (!n8nBase) return res.status(502).json({ ok: false, error: 'n8n is not reachable' })

  try {
    const listRes = await fetch(`${n8nBase}/api/v1/workflows`, { signal: AbortSignal.timeout(5000) })
    if (!listRes.ok) {
      return res.status(502).json({ ok: false, needsManual: true, error: `n8n API returned ${listRes.status}. Open n8n at http://localhost:5678 and activate the workflow manually.` })
    }
    const data = await listRes.json()
    const wf = (data.data || []).find(w => w.name === 'PA Power Outage News Alert')
    if (!wf) return res.status(404).json({ ok: false, error: 'Workflow not found in n8n. Has it been imported?' })
    if (wf.active) return res.json({ ok: true, alreadyActive: true, workflowId: wf.id })

    const activateRes = await fetch(`${n8nBase}/api/v1/workflows/${wf.id}/activate`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000)
    })
    if (!activateRes.ok) {
      const errText = await activateRes.text()
      return res.status(502).json({ ok: false, needsManual: true, error: `Activation failed (${activateRes.status}): ${errText.substring(0,120)}. Try activating manually at http://localhost:5678` })
    }
    return res.json({ ok: true, workflowId: wf.id })
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message })
  }
})

// Serve frontend for any unmatched GET
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

app.listen(PORT, () => {
  console.log(`✅  News-Alert server running → http://localhost:${PORT}`)
  console.log(`    Config: ${CONFIG_PATH}`)
})
