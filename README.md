# SalesNav Enrichment

Scrape a LinkedIn Sales Navigator lead list, enrich every contact on Cloudflare, score it against
your ICP, and download the result as an Excel workbook.

```
Chrome extension                         Cloudflare (free plan)
─────────────────                        ──────────────────────────────
scrape lead pages
  │
  ├─ per contact ──────────────────────▶ POST /proxy/harvest ──▶ HarvestAPI
  │    profile only, no activity           (key attached here)
  ├─ company, deduped ─────────────────▶ POST /proxy/harvest
  ├─ per contact ──────────────────────▶ POST /proxy/score   ──▶ OpenRouter
  │    dossier in, score out               (prompt + ICP + model fixed here)
  │                                      D1: token auth, daily quota, run log
  └─ build .xlsx locally ──▶ download
```

## Why this shape

The obvious design puts the whole pipeline in a Cloudflare Workflow, and that is what this
started as. The **free plan makes it impossible**, and not by a small margin:

| Free-plan limit | What a 1000-contact run needs |
|---|---|
| 50 subrequests per invocation | ~4,300 |
| 10 ms CPU per invocation | ~500 ms just to build the workbook |
| R2 | needs billing enabled at all |

50 subrequests is about twelve contacts. No amount of chunking fixes that inside one instance.

So the worker became a **credential-holding proxy**: one invocation per upstream call, one
subrequest each, near-zero CPU. The browser orchestrates — it has neither limit — and builds the
workbook locally. ~4,300 requests against the free plan's 100,000/day is roughly 20 runs a day.

**What this keeps:** the HarvestAPI and OpenRouter keys never reach the browser, every call is
metered per user in D1, and the ICP and scoring prompt stay server-side and centrally editable.
**What it costs:** the run only advances while Chrome is open. Closing the browser pauses it;
reopening resumes from the persisted cursor without re-fetching anything already paid for.

Moving to Workers Paid ($5/mo) would restore "close the laptop and come back" — the pipeline
would move back into a Workflow. Nothing about the ICP, the scoring or the workbook changes.

The extension holds exactly one credential: a bearer token you mint per user, stored only as a
SHA-256 hash in D1. A leaked token spends money through the proxy but cannot read the keys, and
`DAILY_HARVEST_CALL_LIMIT` / `DAILY_LLM_CALL_LIMIT` bound the damage.

The workbook writer is hand-rolled (`extension/src/enrichment/zip.ts`) rather than SheetJS: a
document-model writer holds the whole sheet XML plus the shared-string table in memory before
zipping, measured at ~40× the output size. Streaming each row through `CompressionStream` keeps a
1000-contact run at ~52 MB peak and a ~2 MB file instead of ~70 MB uncompressed.

Resumability replaces durability. Every chunk boundary persists a cursor to `chrome.storage`, so a
service worker killed mid-run resumes from exactly where it stopped — nothing already paid for is
re-fetched. That is also why the manifest asks for `unlimitedStorage`: a 1000-contact run state is
tens of megabytes.

## Layout

| Path | What |
|---|---|
| `extension/src/content/` | the Sales Navigator scraper |
| `extension/src/background/` | scrape state machine + the enrichment run driver |
| `extension/src/enrichment/` | the pipeline: Harvest client, normalization, dossier, workbook |
| `worker/src/` | credential proxy: auth, quota, `/proxy/harvest`, `/proxy/score`, the ICP |

## Setup

### 1. Worker

```bash
cd worker
npm install

# create the resources (D1 only — no R2, no Workflows)
npx wrangler d1 create salesnav-enrichment-eu --location weur   # paste the id into wrangler.jsonc
npm run db:init

# secrets — these never reach the browser
npx wrangler secret put HARVEST_API_KEY
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put SIMILARWEB_API_KEY   # optional — emails and phones

npm run deploy
```

`SIMILARWEB_API_KEY` switches on the contacts phase: profile URLs are sent to Similarweb's
bulk contact-enrichment endpoint, 25 at a time, and the workbook gains Email, Direct Phone,
Mobile Phone and Contact Accuracy columns. Without the secret the phase is skipped and every
other phase behaves exactly as before. Similarweb bills per returned field — mobile phone 20
data credits, email 4, direct phone 1 — so a 1000-contact run with hits on all three costs
~25k credits.

Set `HARVEST_CONCURRENCY` in `wrangler.jsonc` to your HarvestAPI plan's concurrency
(free 1 / starter 5 / basic 10 / pro 20 / business 40). It also bounds the run's chunk size.

`--location weur` keeps the database in Western Europe. It holds only credential hashes, quota
counters and run metadata — no contact data ever reaches it — but there is no reason for it to
live elsewhere.

### 2. Mint a token

```bash
cd worker
npm run mint-token -- amrit "Amrit Bonnet"
```

Prints the token once and the SQL to register its hash. Run the SQL, hand the token to the user.
Revoke with `UPDATE tokens SET active = 0 WHERE token_hash = '…'`.

### 3. Extension

```bash
cd extension
npm install
npm run build
```

Load `extension/dist` at `chrome://extensions` (Developer mode → Load unpacked).
Open the extension's Settings and fill in:

- **Worker URL** — `https://salesnav-enrichment.<your-subdomain>.workers.dev`
- **API Token** — the `snv_…` token from step 2
- **Target profile** — leave blank; see below

Hit **Test connection** before your first run.

### The ICP

The Sokin ICP lives in `worker/src/icp.ts` — prose, versioned, reviewed in diffs. It defines the
two buying motions (treasury/payments, and embedded infrastructure — the SAP shape), the sectors
with existing proof points, the disqualifier list (competitors, banks, consultants, job seekers,
high-risk verticals), how to weigh company fit against seniority, and which profile and company
signals count as buying triggers. Edit it and redeploy.

Precedence: the extension's **Target profile** field → the `DEFAULT_ICP` var → `src/icp.ts`.
Fill the extension field only to narrow one run (a single vertical or region) — it *replaces*
the default rather than adding to it, so an override must carry its own disqualifiers. The exact
text used is recorded on the workbook's **Run Info** sheet, so a score is always traceable to
what it was judged against.

Each scored row's rationale starts `Motion A —` or `Motion B —`, so the sheet filters by play.

## Using it

1. Open a Sales Navigator lead list
2. Click the extension icon, set a run label, choose how many pages, **Start Scraping**
3. When the run ends the contacts are sent for enrichment automatically
4. The toolbar badge shows finished workbooks; click **Excel** in the popup to download

## What the worker does per contact

All HarvestAPI traffic goes through `/proxy/harvest`, which allowlists exactly these two paths —
a token holder cannot reach endpoints that send connection requests or messages as the account.

| Step | HarvestAPI endpoint | Notes |
|---|---|---|
| Profile | `GET /linkedin/profile` | Sales Nav URLs resolve via `profileId` |
| Company | `GET /linkedin/company` | **deduped** across the batch by `universalName` |

LinkedIn activity (posts, comments, reactions) is deliberately **not** pulled: the personal and
company profiles are what the export needs, and each activity endpoint was a paginated call per
contact.

Then one OpenRouter call scores the whole dossier against your ICP and returns fit score, tier,
buying role, signals, risks, and a personalized opening line.

### Cost per 1000 contacts

- **HarvestAPI** — 1 call per contact (profile), plus one per *distinct* company. ~1,300 calls
  for a 1000-contact list at ~300 unique employers. It was ~4,300 while activity was pulled.
- **OpenRouter** — 1 call per contact. The dossier is now profile + company only, so the input
  is a fraction of the ~7.7k tokens the activity-carrying dossier measured; re-measure with
  `npm run smoke` before quoting a figure. On `google/gemini-2.5-flash` ($0.30/M in, $2.50/M out)
  the old, larger dossier cost ≈ $4 per 1000 contacts — this is an upper bound now.
- **Cloudflare** — the free plan covers this worker; D1 is pennies here.

To spend less still, trim `LIMITS` in `extension/src/enrichment/dossier.ts` (about, description,
experience, skills).

## The workbook

| Sheet | Contents |
|---|---|
| **Scored Contacts** | One row per person, best fit first. 15 columns: Personal Linkedin URL, First Name, Last Name, Job Title, Company Name, Website, Company Type, Company HQ, Company offices, Company Linkedin URL, Personalized Hook, Top Skills, Tenure (months), Rationale, Current Experiences (`Company — Title (start year)`, pipe-separated). |
| **Run Info** | Job metadata, the ICP used, data-quality counts, tier distribution. |

Rows are still sorted by fit score even though the score itself is no longer a column. A contact
whose profile lookup failed keeps the scraped name and Sales Navigator URL rather than going
blank; **Run Info** carries the per-run count of what failed.

## Who used what

Every proxied call is metered, and every run is logged:

```bash
# per-user daily spend
npx wrangler d1 execute salesnav-enrichment-eu --remote --command \
  "SELECT * FROM daily_usage ORDER BY day DESC"

# per-run history
npx wrangler d1 execute salesnav-enrichment-eu --remote --command \
  "SELECT user_id, label, status, contact_count, scored_count, harvest_calls, llm_calls, created_at
     FROM runs ORDER BY created_at DESC LIMIT 20"
```

## Checks

```bash
cd extension && npm test   # 12 assertions: URL mapping, company slug fallback, industry
                           # flattening, pool concurrency, partial-run export, a dossier that
                           # carries no activity, workbook round-trip through a real xlsx
                           # parser, 1000-row scale
cd worker && npm test      # 4 assertions: score parsing and the ICP

# live, against the deployed worker — costs real credits
cd extension && WORKER_URL=https://... API_TOKEN=snv_... \
  npm run smoke -- https://www.linkedin.com/in/some-profile
```

## Operating notes

- **Run stuck?** `npx wrangler tail` for live worker logs. The run resumes from its cursor on the
  next tick; the popup can stop it, and a stopped run still exports every row already enriched.
- **Keep Chrome open** while a run is in flight. It pauses on close and resumes on reopen.
- **Scraping is rate-limited by design** — Gaussian inter-page delays, per-session cooldowns,
  a daily cap and a working-hours guard. Raising them raises your detection risk.
