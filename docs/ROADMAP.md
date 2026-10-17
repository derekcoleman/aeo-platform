# Roadmap

Where the platform stands, where it is going, and what the first round of
work on branch `claude/charming-ramanujan-kdmnd6` shipped. Written 2026-10-17.

**How this was built.** A code analysis of all eight subsystems at `cac7d6a`
(the base of this branch). Every high-impact gap was checked against the code:
63 confirmed, none refuted. Market research covered six tracks: competitors,
how each AI engine picks its sources, the senior B2B SaaS playbook,
integrations, autonomous-agent practice, and Google spam-policy risk. Four
strategy proposals were merged, then critiqued from three angles: an SEO
director, a staff engineer and a VP Marketing buyer.

> **About the market numbers.** Funding rounds, valuations, launch dates and
> study figures (for example "84% of citations are earned media" or "0.664
> correlation") come from secondary sources found through web search. Vendor
> and study pages could not be opened to check them, so treat every such
> figure here as unverified. None goes into customer-facing copy until it is
> sourced.

**Status markers.** *Shipped (item N)* means built and committed on this
branch as item N of this round (see [This round](#this-round)). *Partly
(item N)* names what shipped and what is left. Anything else is not started.

## Contents

- [Executive summary](#executive-summary)
- [North star](#north-star)
- [Where we stand](#where-we-stand)
- [Bugs found and their status](#bugs-found-and-their-status)
- [Phases and initiatives](#phases-and-initiatives)
- [New agent skills](#new-agent-skills)
- [Missing integrations](#missing-integrations)
- [Autonomy design](#autonomy-design)
- [Competitive edge](#competitive-edge)
- [Market and research digest](#market-and-research-digest)
- [Subsystem map](#subsystem-map)
- [Risks](#risks)
- [This round](#this-round)
- [What comes next](#what-comes-next)

## Executive summary

The structural bet is right for mid-market B2B SaaS. Pages are zero-JS and
carry complete JSON-LD. They are served on the customer's own domain through
a reverse proxy, every claim is grounded in a brand brain, and the work runs
on durable Inngest jobs. At `cac7d6a`, though, the platform could not deliver
what it sells:

- **No run could finish.** Under the default `approve_both` policy the
  approval gate matched on the trigger event (`event.data.approvalId`)
  instead of the awaited one (`async.data.approvalId`), so every gate expired
  after seven days. Every brief and draft call also returned 400 on Claude 5
  models, because `temperature` was always sent.
- **Nothing could be taken down.** There was no unpublish, 410, noindex,
  rollback or kill switch.
- **The edge could be poisoned.** The customer's Cloudflare Worker cached 3xx
  responses for 60 seconds, so a client-forgeable redirect header became
  cache poisoning on the customer's domain.
- **Several customer-facing numbers were wrong.** Per-asset GA4 and Search
  Console figures were always 0. Profound's answers counted as Google AI
  Overviews, and Reddit, G2 and Wikipedia counted as competitors. Crawl
  history was overwritten with partial days.
- **Strategy ran on constants.** `brandFit` was always 50, there was one page
  per question, and nothing checked coverage or cannibalisation.
- **Enterprise basics were absent.** No SSO, SCIM, SOC 2, DPA, uptime SLO
  or exit plan.

**This round** (ten commits, one pull request) fixes the foundation and
lands the first strategy tranche:

1. Approvals resume and models answer.
2. Security holes closed, and Worker v2.
3. Every number re-derived and restated.
4. Takedown, kill switches and rollback.
5. An atomic spend governor.
6. Named competitors and source roles.
7. An answer ledger with API-grounded engine probes through OpenRouter.
8. One expected-value scorer, plus a publish-safety kit.
9. The competitor organic keyword gap.
10. These docs and a cloud-session startup hook.

Of the 49 bugs the analysis found, 27 are fixed, 10 are partly fixed, and 12
are deferred to a named initiative (see
[Bugs](#bugs-found-and-their-status)).

**What the analysis recommends**, answering the owner's five questions:

1. **Code for AI visibility and organic performance.** Ship correct pages,
   make the surface safe, and make every number true, with a restatement
   note. Then add the missing organic layer: competitor organic gap, rank and
   share-of-voice series, page inventory, intent clusters keyed on SERP
   overlap, hubs and internal links, honest freshness, IndexNow. Treat
   llms.txt and schema as hygiene, since controlled studies show no citation
   lift from either.
2. **New agent skills.** Fifty, across measurement, strategy, execution,
   earned media and governance (see [New agent skills](#new-agent-skills)).
3. **Missing integrations.** In order:
   - DataForSEO Labs and Google AI Mode, on keys already held.
   - Search Console query×page and URL Inspection.
   - GA4 key events.
   - The direct Anthropic SDK.
   - IndexNow.
   - Cloudflare crawler-block detection.
   - SSO and SCIM.
   - Then HubSpot, Salesforce and a warehouse export.

   See [Missing integrations](#missing-integrations).
4. **Operating like a senior strategist.**
   - The north star is recommendation share against named rivals, on a
     customer-owned, frozen prompt panel.
   - Statistics are honest: paraphrase sampling, cluster-level intervals and
     stepped-wedge lift.
   - One canonical URL per intent.
   - Briefs must beat the current answer with first-party information gain.
   - Money-page, docs and earned-media workstreams run alongside the blog.
   - Customers get a week-1 baseline, a quarterly plan and a QBR pack.
5. **Autonomy.** Deterministic code decides what ships, and a model writes
   memos, briefs and proposals. Autonomy is earned per site and per topic,
   starting with changes visitors cannot see. It is design-only this round
   (see [Autonomy design](#autonomy-design)).

**Dates and capacity.** Week 0 is 2026-10-19. Effort sizes: S ≈ 1, M ≈ 3,
L ≈ 6 and XL ≈ 10 engineer-weeks. The committed scope is about 190
engineer-weeks, which is roughly six engineers at 75% focus for 44 weeks.
With four engineers, everything marked *later* moves to H2 2027.

| Milestone | Date | Scope |
|---|---|---|
| Phase 1 exit | 2026-12-11 | The foundation (most of it shipped this round), plus pipeline hardening, the outcome ledger, GSC/GA4 widening, event consumers and the onboarding gate. The trust pack starts. |
| Phase 2 exit | 2027-02-26 | Native sampling on frozen panels, the week-1 baseline, visibility home and QBR, organic gap, earned target list, accuracy judge, HubSpot attribution |
| GA cut line | 2027-03-31 | Phases 1 and 2, plus intent clusters, brief v3, QA v2 core, refresh lifecycle and campaign ledger |
| Q2 2027 | | Research stage, entity graph and E-E-A-T, hubs, off-site engine, stepped-wedge lift readouts, full safety governor, risk-policy engine, dispatcher at L1 |
| Q3 2027 | | L2 and L3 per site, decision layer and memo, outcome learning, WordPress and HubSpot CMS |

**Below the cut line**, deliberately:

- Section-by-section drafting.
- Original data and PR, offered as a managed service first.
- Community, video and LinkedIn programs.
- Bring-your-own-draft.
- CMS adapters beyond WordPress and HubSpot.
- Log drains and Web Bot Auth.
- Proxy split tests.
- Teams, Gong, Intercom and Zendesk.
- Hosted agent frameworks.
- Neyman allocation.
- The customer MCP server.

**Positioning:** safe autonomy, provable lift, no CMS project, and the
customer owns the scoreboard.

## North star

**Primary: demand-weighted AI Recommendation Share.** This is the brand's
share of the buyer's shortlist. It is measured on each customer's approved,
frozen MOFU/BOFU prompt panel against the named competitors, per engine and
blended. It is measured weekly and reported monthly and quarterly.

*Open decision:* "blended" assumes every engine is collected the same way.
With engine sampling through OpenRouter only, AI Overviews come from our SERP
trackers (AI Mode only through Profound today), while ChatGPT, Perplexity and
Gemini are API-grounded probes. The never-blended rule
([MEASUREMENT.md](MEASUREMENT.md#never-blended)) forbids adding SERP, probe
and Profound series together, or probes to each other. Until the owner
restates the headline, Recommendation Share is reported per engine and per
collection method only: the formula below runs for one engine at a time, so
`w_engine` drops out, and no blended figure is computed.

**Organic co-primary:**

- Non-brand organic clicks to the subfolder and to money pages.
- Top-3 rank share on a tracked commercial keyword set, from Search Console
  and our own organic rows.

Citations are reported separately, as citation share (owned and earned), and
never folded into the headline.

| Step | Rule |
|---|---|
| Panel | Versioned per site and approved by marketing and product marketing. Frozen per quarter, every change logged, never silently rebased. About 60% MOFU/BOFU intents (pricing, *vs <rival>*, SOC 2, integrations). An audit slice of 10–15% is never targeted by content. The adaptive discovery panel is kept separate and never changes the denominator. |
| Sampling | 3–5 paraphrases × 1–2 samples per intent, per engine, per week, spread across days, with cached rows excluded. Engines: AI Overviews, AI Mode, ChatGPT, Perplexity and Gemini. Copilot comes monthly from Bing's CSV, Claude runs as a diagnostic, and Grok and Meta come only through Profound. Depth is set by plan. |
| Formula | RecShare = Σ demand × w_engine × 1[brand recommended or shortlisted] ÷ Σ demand × w_engine, summed over intents. `w_engine` is an exposure weight: usage share, or an audience mix the customer chooses. It is not AI-referral share, which over-weights ChatGPT because AI Overview clicks land in GA4 as organic. The same formula runs for every named rival. |
| Uncertainty | Bootstrap by intent, then by paraphrase. Report at cluster level only, never per question at n = 3. Use a paired difference against the top rival over the same draws: a cluster is *won* when P(brand − top rival > 0) ≥ 0.9. Every claim carries a label: *leading*, *likely* or *proven*. |
| Lift | Stepped-wedge (staggered adoption) difference-in-differences. Within capacity, randomise when each eligible cluster is treated. Not-yet-treated clusters are the controls, and every cluster is eventually treated. Pool across clusters and tenants with shrinkage. Lift is *proven* only when the 90% interval excludes 0. |
| Evidence ladder | Monthly per cluster: indexed → crawled or retrieved (user-triggered fetches) → cited → recommended → AI-referral sessions → pipeline. |

**Supporting metrics:**

- Cited-but-not-recommended rate.
- Fan-out coverage.
- Branded-search lift (Search Console brand-regex impressions).
- Search Console AI impressions and Bing citations, as first-party
  calibration.

**Business metric:** AI-influenced pipeline and revenue from the CRM
(HubSpot, then Salesforce) plus self-reported attribution, with explicit
caveats.

**Outcome target:** brand accuracy of at least 90% on branded prompts per
engine. It is a target, not a guardrail, because the engines are outside our
control.

**Hard guardrails.** These are controllable and they override optimisation:

- 30-day cohort index rate ≥ 80%.
- Zero manual actions.
- No statistically significant drop in organic clicks to the customer's
  existing money pages and blog against their pre-period trend (no
  cannibalisation).
- Core Web Vitals pass on rendered pages.
- Zero publishes outside approved topics, and zero published claims failing
  audit.
- Spend within budget.

**What exists after this round.** The answer ledger records each answer's
engine, collection method and sample index, plus a paraphrase column that
nothing writes yet. Strategy → Visibility shows Recommendation Share and
Citation Share per engine with 95% Wilson intervals, from API-grounded probes
(see [MEASUREMENT.md](MEASUREMENT.md)). The frozen panel, paraphrases,
cluster-level bootstrap and stepped-wedge lift are Phase 2 and 3 work.

## Where we stand

The grades are the analysis's, taken at `cac7d6a`. The last column says what
this round changed. No area is re-graded until its phase exit criteria are
met.

| Area | Grade | At `cac7d6a` | This round |
|---|---|---|---|
| Native AI-answer measurement | D | Google AI Overviews was the only engine measured natively, with one sample per question and no variance model. Other engines came only through Profound, stored as AI Overview rows. The cache key had no engine or sample. | Answer ledger with engine and method. Profound relabelled `third_party`. API-grounded probes of four engines through OpenRouter, with intervals (items 3, 7). |
| Measurement integrity and attribution | F | Per-asset GA4/GSC was always 0 and the AI Overview lift baseline was structurally 0. Site GSC clicks were double-counted, crawl days overwritten and dead gaps kept alive. A SerpApi key-name mismatch, and DataForSEO limited to 10 countries. | All fixed and restated, except the AI Overview baseline, which needs the outcome ledger (item 3). |
| Competitive intelligence and share of voice | D | Every non-owned cited domain was a "competitor", Reddit and G2 included. No registry, share of voice or organic gap. | Named-competitor registry with 13 source roles (item 6). Competitor organic keyword gap (item 9). Recommendation share per rival per engine (item 7). |
| Organic SEO execution | D | Organic positions were stored but never read. The prefix root returned 404 and there were no hubs. Links came from the 25 newest pages. `dateModified` was bumped on every republish. No IndexNow. | A striking-distance flag inside the organic gap only (item 9). |
| Demand and prompt discovery | C | The question graph works, but it discarded paid commercial suggestions and had no volume ground truth. It drifted across re-mines and never promoted GSC queries. Onboarding mining could exceed the step limit. | Mining runs in persisted batches, with idempotent sightings and cluster reuse (item 3). Volume and intent arrive with the organic gap (item 9). |
| Strategy and prioritisation | D | Fixed constants and a `brandFit` of 50. Topicless questions outranked priority topics. One page per question, and producers overwrote each other. | One EV scorer for every producer, action types, coverage guard and topical floor (items 3, 8). |
| Content generation and grounding | C | The design is strong: facts resolved in code, verbatim-quote sources, a versioned manifesto. But the default path was broken: 400s, gates never resolving, a duplicated FAQ, truncation. No research stage. | The default path works (item 1). FAQ only with evidence (item 8). |
| QA gates | C | The structure gate scored a preview with no JSON-LD, so 24 of 100 points were unreachable. Weak numeric regex. Manifesto bans enforced only in the prompt. The judge was never called. | Structure is scored on the served document (item 1). New safety gate (item 8). |
| Published surface | C | Zero-JS HTML, the leak guard, deterministic JSON-LD and identical output for every user agent are real advantages. But the Worker forced cache TTLs and had no version. No unpublish or rollback. Double-quoted ETags. `.md` and `llms-full` indexable. `trailing_slash=always` broken. An anonymous publisher. | Worker v2, takedown, rollback, kill switches and the ETag fix (items 2, 4). |
| Security and multi-tenancy | D | SSRF via IPv6 literals. Cross-tenant OAuth binding. A forged internal redirect, cached by the Worker. Lost webhook events. Slack approvals not identity-checked. HMAC secret shown to viewers. Spoofable bot IP. Unchecked cross-site ids. A bypassable theme sanitiser. | Closed (items 1, 2), except Slack identity mapping, the theme sanitiser and the DNS-rebinding window. |
| Enterprise readiness and trust | F | No SSO, SCIM, SOC 2, DPA, sub-processor list, SLO, status page, exit plan or takedown path. | Takedown path only (item 4). |
| Entity, E-E-A-T and off-site authority | F | The publisher Organization has no `@id` or `sameAs`. One default byline. Facts never public. No earned or off-site capability. | Sources shaping answers listed by role (item 6). |
| Integrations and connectors | C | A clean adapter framework with Vault secrets, but narrow coverage. The Google backfill runs in one step. GA4 is prefix-filtered and on a deprecated metric. Failures raise no alert. | DataForSEO Labs `ranked_keywords` (item 9). OpenRouter probes (item 7). Vendor timeouts and location codes (item 3). |
| Refresh and content lifecycle | C | An explainable refresh score, but it counted organic rows as AI citations and queued cited winners for rewrite. No protect class, noindex, 410 or auto-revert. Webflow only. | Protected winners get figures-and-dates updates. Citation counts are AI Overview only. Noindex, retire and rollback (items 3, 4, 8). |
| Orchestration and reliability | D | Gates never resolved. Eleven emitted events had no consumer. No `onFailure` or `cancelOn`, and one heartbeat. `publishedAt` drifted. The draft step re-pays the model on a DB error. | Gate fixed, `publishedAt` memoised, webhook re-drive (items 1, 2). |
| Cost governance and unit economics | D | A non-atomic SERP guard. No LLM budget, article cap or cost per run, and unenforced entitlements. The planned sampling would cost $200–1,250 a month per $299 Pro site. | Atomic governor for pipeline model, SERP and probe spend, a per-article cap and alerts (item 5). Audit model calls and embeddings are not yet governed. |
| Audit / lead magnet | C | Clean engineering, but it measures readiness only and over-weights schema and llms.txt. False criticals, a dead `bingbot` rule, leads lost on cache hits. The monthly audit is never scheduled. | None. The audit fixes are next. |
| Reporting and executive UX | D | The home page is an install console. No trends, share of voice, answer explorer, baseline report, digest or QBR. Wrong KPIs. | Methodology note on Strategy, Demand, Attribution and Refresh. Engines card (items 3, 7). |
| Autonomy readiness | F | Nothing started work on its own. No kill switch, rollback, budget, evals or activity log. A wrong reward signal and an all-or-nothing policy. | Kill switch, rollback and budgets exist (items 4, 5). The rest is Phase 4. |

## Bugs found and their status

The analysis listed 49 bugs, each verified against the code at `cac7d6a`.
Each one was re-checked against this branch, in the code rather than the
plan: **27 fixed, 10 partly fixed, 12 deferred**. A deferred bug, or the
deferred part of one, names the initiative that owns it.

| # | Severity | Bug at `cac7d6a` | Status on this branch |
|---|---|---|---|
| 1 | high | The approval gate matched `event.data.approvalId` (the trigger) instead of `async.data.approvalId`, so every gate expired after 7 days | Fixed, item 1 |
| 2 | high | `runJsonTask` always sent `temperature: 0.3`, and Claude 5 models return 400 | Fixed, item 1 |
| 3 | high | The audit modules' 400–1,500 token caps would truncate under adaptive thinking | Fixed, item 1 (4,096 tokens at low effort; per-task budgets) |
| 4 | high | The Worker forced `cacheTtlByStatus` over origin headers, caching 3xx for 60s, and had no version or upgrade path | Fixed, item 2 (Worker v2; Mode A sites must redeploy it) |
| 5 | high | A client-sent `x-aeo-internal-redirect` survived middleware, giving an open redirect and cache poisoning; `/render` on the app host trusted client headers | Fixed, item 2 |
| 6 | high | `SERPAPI_KEY` vs `SERPAPI_API_KEY` mismatch | Fixed, item 3 (`lib/serp/env.ts`; the old name still works, with a warning) |
| 7 | high | Per-asset GA4/GSC joined on `dimension->>'path'`, which nothing writes, so it was always 0 | Fixed, item 3 |
| 8 | high | The `crawl_daily` rollup overwrote complete days with partial counts | Fixed, item 3 |
| 9 | high | SSRF: IPv6 literals such as `[::ffff:7f00:1]` and NAT64 addresses passed the guard | Fixed, item 2 |
| 10 | high | The OAuth start route never checked that the site belongs to the org | Fixed, item 2 (route check plus a DB trigger) |
| 11 | high | The webhook ledger row was written before processing, so failed Stripe and Slack events were acknowledged as duplicates | Fixed, item 2 (claim, release on failure, re-drive every 15 minutes) |
| 12 | high | The FAQ was appended twice at publish | Fixed, item 1 (plus a staff remediation job for live pages) |
| 13 | high | The structure gate scored a preview without JSON-LD, byline or dates | Fixed, item 1 |
| 14 | high | Plan copy promised 3–4 articles a week, a monthly readiness audit and per-asset attribution, none of which the product could deliver | Partly: the pipeline (item 1), attribution (item 3) and the article copy (item 8) are fixed. The monthly audit is still unscheduled → `audit-v2-monitored` |
| 15 | medium | `publishedAt` was computed outside a step, so the re-measure windows drifted | Fixed, item 1 |
| 16 | medium | QA source verification used global `fetch`, with no SSRF guard or size cap | Fixed, item 1 (`safeSourceFetcher`) |
| 17 | medium | `citationGaps` filtered before `DISTINCT ON`, keeping dead gaps open | Fixed, item 3 (latest native snapshot within 45 days) |
| 18 | medium | The refresh scan counted organic, PAA and featured-snippet rows as AI citations | Fixed, item 3 |
| 19 | medium | `siteSignals` summed `gsc_page` and `gsc_query`, doubling clicks | Fixed, item 3 |
| 20 | medium | Profound's Gemini and AI Mode were mapped to `google_aio`, and every Profound row was written as an AI Overview | Fixed: the normaliser in item 3, engine labels and surfaces in item 7 |
| 21 | medium | The refresh score queued cited evergreen winners for rewrite, and posts with no data scored 47.5 | Partly: winners are protected (item 3) and get figures-only updates (item 8). The neutral no-data default remains → `refresh-decay-lifecycle` |
| 22 | medium | Excluded questions were re-tracked and billed, and paused sites were still tracked | Fixed, item 3 |
| 23 | medium | `demand-mine` ran about 600 vendor calls in one step | Fixed, item 3 (persisted batches of five seeds) |
| 24 | medium | The 16-month GSC/GA4 backfill runs in one non-paged step and restarts daily | Deferred → `gsc-ga4-widening` |
| 25 | medium | DataForSEO mapped 10 countries and threw for the rest | Fixed, item 3 (ISO numeric codes; unknown countries fall back to the US, flagged) |
| 26 | medium | Slack approvals were not identity-checked, `conversations.join` lacked `channels:join`, reinstall was blocked, and app decisions left Slack buttons live | Partly: Slack decisions count only for the workspace's own org, and app decisions update Slack (item 1). Identity mapping, the scope and reinstall → remainder of `security-hardening` |
| 27 | medium | Cross-site topic and question ids went unchecked over a connection that bypasses RLS | Fixed, item 2 |
| 28 | medium | Opportunities get stuck: no `onFailure`, throws before the try block, no revert on a failed dispatch, no reaper | Deferred → `pipeline-hardening` |
| 29 | medium | The draft step bundles the model call with DB writes, and opening a gate is not idempotent | Deferred → `pipeline-hardening` |
| 30 | medium | The signal bridge and gap scan overwrote each other under `question:<id>`, and the post-publish loop can open three refresh rows per item | Partly: per-producer evidence is merged (item 3). One refresh row per window remains → `truthful-outcome-ledger` |
| 31 | medium | Topicless questions got a business value of 50 and outranked priority topics | Fixed, items 3 and 8 |
| 32 | medium | Indexable and noindex variants shared a public cache entry with no `Vary`, and the ETag was double-quoted | Fixed: `Vary` and `private, no-store` in item 2, the ETag in item 4 |
| 33 | medium | `trailing_slash='always'` breaks articles, and `sitemap.xml`, `llms.txt` and `.md` get a slash appended | Deferred → `published-surface-hygiene` |
| 34 | medium | Bot verification trusted a client-sent `cf-connecting-ip` | Fixed, item 2 (`trustedClientIp`) |
| 35 | medium | The regex theme sanitiser can be bypassed (staff-only input) | Deferred → remainder of `security-hardening` |
| 36 | medium | The proxy HMAC secret was rendered to every role | Fixed, item 2 (owners and admins only); DB column privileges deferred |
| 37 | medium | Profound deleted the range before fetching, and any failed sync, a 429 included, set the connection to `error`, which blocks Webflow | Partly: Profound fetches first, then sweeps (item 3). Transient failures still set `error` → `event-consumers-observability` |
| 38 | medium | Extracted fact quotes are never checked against their documents, and sources that failed verification are re-offered to the drafter | Deferred → `pipeline-hardening`, `research-information-gain` |
| 39 | medium | Install copy falsely claims "we merge your llms.txt"; the root llms files are unreachable in Mode A; the Worker's cache fallback can never hit; the mirror has not shipped | Deferred → `published-surface-hygiene` |
| 40 | medium | The `bingbot` rule never matches the crawler named `Bingbot`, and robots-disallowed sampled paths fire false criticals | Deferred → `audit-correctness-fixes` |
| 41 | low | `Blog` is listed as a deprecated type, and `sameAs` is matched with `endsWith` | Deferred → `audit-correctness-fixes` |
| 42 | low | Audit status transitions are unguarded, the lead email is dropped on cache hits, audit PII is never purged, and the audit bot ignores robots.txt | Deferred → `audit-correctness-fixes` |
| 43 | low | The topic "published" count reads 0 for new content, and `questions_tracked` counts every question with any snapshot | Deferred → `baseline-report-visibility-home-v0` |
| 44 | low | Clusters were duplicated on every mine, parent-link normalisation differs, `seen_count` double-counted, and `demand_score` uses `greatest()` | Partly: cluster reuse and idempotent `seen_count` (item 3). Parent links and `demand_score` → `demand-ground-truth` |
| 45 | low | Prefix price matching billed Opus 5.5 as Opus 5 and Haiku 5.5 at $5/$25, and titles may be 120 characters against the 110 JSON-LD limit | Partly: longest-prefix prices (item 1). Title bound → `pipeline-hardening` |
| 46 | low | `z.coerce.boolean` read "false" as true, GA4 requests the deprecated `conversions` metric, and `bing.com/chat` can never match a host | Partly: the boolean is fixed (item 3). GA4 → `gsc-ga4-widening` |
| 47 | low | Degraded bag-of-words embeddings persist, and SERP vendor fetches had no timeout | Partly: vendor deadlines (item 3). Re-embedding waits for an embeddings key |
| 48 | low | Fact extraction hard-codes concurrency 3, and pausing a site did not invalidate the resolver cache | Partly: the renderer reads the pause on every request and the same process invalidates (item 4). Concurrency → `event-consumers-observability` |
| 49 | low | The Slack "decided" line wraps a username in user-mention syntax, the approval page misdescribes "request changes", the delete dialog's count is capped at 10, and the publishing page calls Webflow serially during render | Deferred: the Slack line and copy → `pipeline-hardening`; the rest is backlog |

## Phases and initiatives

| Phase | Window | Goal | Initiatives | This round |
|---|---|---|---|---|
| 1. Foundation | 2026-10-19 → 2026-12-11 (weeks 0–8) | Ship safely, tell the truth, earn trust | 15 | 8 shipped |
| 2. Visibility intelligence | 2026-11-30 → 2027-02-26 (weeks 6–18) | A scoreboard the customer owns and believes | 20 | 1 shipped, 2 partly |
| 3. Senior execution | 2027-01-25 → 2027-06-04 (weeks 14–32) | Work like a senior SEO/AEO director, safe at scale | 20 | none |
| 4. Accountable autonomy | 2027-04-19 → 2027-08-27 (weeks 26–44) | Policy-bounded, deterministic-first autopilot | 7 | design only |

Each initiative lists impact (1–5), effort (S, M, L) and the analysis's
confidence, what it depends on, and what "done" means.

### Phase 1: Foundation

**Goal.** Make the default path ship a correct page and give every live page
an off switch. Close the security holes, including in the customer-deployed
Worker. Make every number customers see true, and restate the old ones
openly. Stop the scaled-content exposure now rather than later. Lay the
governance spine that both senior strategy and autonomy need: budgets,
outcome ledger, events, activity log and trust pack.

**Exit, engineering:**

- An Inngest dev-server test in CI proves that an app or Slack approval
  resumes a run within 60 seconds. (Open: CI has no Inngest CLI, so the gate
  is unit-tested with a fake step for now.)
- 0 brief or draft 400s, and 0 `max_tokens` truncations, in `ops.llm_calls`
  over 14 days.
- Published HTML is byte-equal to the HTML that passed QA. (Tested, item 1.)
- Every SQL-semantics fix has a `tests/db` test.
- Every verified security vector has a regression test.
- Worker v2 is released, with an outdated-install alert. (Done, item 2.)
- Every model and SERP call reserves budget atomically. (Partly, item 5:
  `runJsonTask` model calls, every SERP call through `cachedCall` and the
  answer probes hold budget. Audit model calls and embeddings do not yet.)
- 0 Profound or LLM rows reach a native AI Overview metric. (Done:
  `v_native_aio`, items 3 and 7.)

**Exit, customers** (3–5 named design partners, with goals agreed up front):

- At least 10 pages shipped end to end through brief, gate, publish and
  outcome row.
- The kill switch demonstrated on a live partner domain, noindexing every
  platform page within 5 minutes.
- A weekly report built on the restated numbers, with a restatement note.
- Baselines captured, so later deltas can be measured.

| Initiative | Title | Impact · effort · confidence | Depends on | Status |
|---|---|---|---|---|
| `pipeline-hotfix` | Approvals that resume, models that answer, pages that match QA | 5 · S · high | none | Shipped (item 1) |
| `security-hardening` | SSRF, cross-tenant, cache-poisoning, webhook-loss and approval holes, including the Worker | 5 · L · high | none | Shipped, core (item 2) |
| `takedown-kill-switch` | Takedown, kill switch and one-click rollback | 5 · M · high | security-hardening | Shipped (item 4) |
| `measurement-integrity` | Make today's numbers true and restate them openly | 5 · M · high | none | Shipped (item 3) |
| `audit-correctness-fixes` | False criticals, dead rules, lost leads, PII, overclaiming copy | 3 · S · high | none | Not started |
| `spend-governor` | Atomic spend governor and run-level cost ledger | 5 · M · high | none | Shipped (item 5) |
| `pipeline-hardening` | Terminal states, cancellation, safe re-dispatch, honest bylines, idempotent steps | 5 · M · high | pipeline-hotfix | Not started |
| `publish-safety-kit` | Coverage check, velocity cap, topical floor, injection and leak scan | 5 · M · medium | pipeline-hotfix | Shipped (item 8) |
| `gsc-ga4-widening` | Site-wide queries, query×page, URL Inspection, key events | 5 · M · high | measurement-integrity | Not started |
| `answer-ledger-schema` | Engine, method, sample and paraphrase dimensions behind SQL views | 4 · M · high | measurement-integrity | Shipped (item 7) |
| `truthful-outcome-ledger` | Outcome ledger per asset and engine, on fresh evidence | 5 · M · high | measurement-integrity, pipeline-hotfix, answer-ledger-schema, spend-governor | Not started |
| `source-role-ledger` | Named-competitor registry and deterministic source roles | 5 · S · high | measurement-integrity | Shipped (item 6) |
| `event-consumers-observability` | Event consumers, heartbeats, alerts, agent activity log | 4 · M · high | pipeline-hotfix, spend-governor | Not started |
| `onboarding-readiness-gate` | AI-crawler blocks, snippet directives, site integration, ownership signals | 4 · S · high | security-hardening | Not started |
| `enterprise-trust-pack` | SSO and SCIM, roles, SOC 2, DPA, SLO and status page, exit plan | 4 · L · medium | security-hardening, takedown-kill-switch | Not started |

#### `pipeline-hotfix`: Shipped (item 1)

- **Problem.** Under the default `approve_both` policy no run could finish.
  - The gate matched on the trigger event, so it expired at 7 days.
  - `runJsonTask` always sent `temperature`, which Claude 5 models reject
    with a 400. Once that was removed, adaptive thinking would have truncated
    the audit modules' 400–1,500 token caps.
  - Publish appended the FAQ a second time.
  - The structure gate scored a preview without JSON-LD.
  - `publishedAt` drifted on replay.
  - QA fetched sources with plain `fetch`.
  - Slack preview links returned 404.
- **Build.**
  - Match `async.data.approvalId`, and wait in roughly 6-hour windows that
    re-read the approval row.
  - Drop sampling parameters for current Claude models. Set effort and
    `max_tokens` per task. Retry once on `max_tokens`, and send refusals to a
    human.
  - Recompose without re-appending the FAQ, with a byte-equality test.
  - Score the composed page.
  - Memoise `publishedAt`.
  - Use `safeFetch` in QA.
  - Point preview links at `/app/approvals/[id]`.
  - A one-off job re-renders live pages that carry a duplicated FAQ.
- **Done when:**
  - Approved gates resume within 60 seconds in a CI integration test.
  - 0 brief or draft 400s.
  - 0 audit truncations over 7 days.
  - 0 pages with a duplicated FAQ.
  - At least 10 pages shipped end to end on design partners within 3 weeks.
- **Left over.** The dev-server resume test (see the Phase 1 exit). Moving
  to the SDK and streaming is `model-runtime-core`.

#### `security-hardening`: Shipped, core (item 2)

- **Problem.**
  - An IPv6 SSRF bypass, plus a DNS-rebinding window.
  - The OAuth start route would bind any site.
  - A forged `x-aeo-internal-redirect` was honoured, and the Worker (which
    had no version or upgrade path) cached the result.
  - Webhook events were lost.
  - Slack approvals were not identity-checked, `channels:join` was missing
    and reinstall was blocked.
  - Cross-site ids went unchecked.
  - The HMAC secret was shown to viewers.
  - The bot IP could be spoofed.
  - The theme sanitiser could be bypassed.
- **Build.**
  - A byte-level IPv6 parser that applies the IPv4 rules to embedded
    addresses, plus a connection pinned to the vetted IP.
  - A site-in-org check in the route, backed by a DB trigger. Site-scoped id
    checks and site filters in the strategy actions and brief context.
  - Strip every incoming `x-aeo-internal-*` header, and return 404 for
    `/render/*` off the edge host. Send `private, no-store` and
    `Vary: X-Forwarded-Host` on non-indexable responses.
  - Worker v2: no 3xx caching, strip `x-aeo-*` headers, report its version
    in telemetry, and raise an outdated-install alert.
  - Webhook claim and re-drive.
  - Slack member identities and per-site approvers.
  - The HMAC secret for managers only.
  - Platform-provided client IPs only.
  - A parse5 sanitiser for themes.
- **Done when:**
  - Every vector has a regression test.
  - A penetration test finds 0 honoured client `x-aeo-internal-*` headers.
  - 0 cached 3xx responses on v2 sites.
  - Every Mode A install is on v2 within 30 days.
  - 0 Slack approvals from unmapped users.
  - 0 lost webhooks over 30 days.
  - 0 cross-org bindings possible.
- **Left over.**
  - Slack identity mapping, `canEdit` on Slack approvals, `channels:join` and
    the reinstall upsert, which need an identity model.
  - DNS pinning.
  - DB column privileges on the HMAC secret.
  - The parse5 theme sanitiser.
  - A scoped Cloudflare deploy token.

  Mode A sites are protected at their edge only once they redeploy the
  Worker.

#### `takedown-kill-switch`: Shipped (item 4)

- **Problem.** There was no way to unpublish, return 410, noindex, redirect
  or roll back a page, and pausing a site did not stop in-flight publishing.
  Buyers' security and legal teams will not approve even a gated pilot
  without an off switch.
- **Build.**
  - `published_pages.status` (`live`, `noindex`, `retired`), with per-page
    actions.
  - `app.sites.indexing_paused` and `ops.autonomy_controls` (global, org,
    site). These noindex every platform page and empty the sitemap, llms
    files and feed.
  - One-click rollback from the stored version, with no model call.
  - Publishing re-checks the pause.
  - Audit rows and Slack or email notices.
- **Done when:**
  - The kill switch noindexes every platform page and empties the listings
    within 5 minutes, on a design partner's domain.
  - Rollback completes in under 2 minutes.
  - No takedown needs a manual DB edit.
- **Left over.** Slack takedown buttons, which need identity mapping. A 301
  redirect action (`refresh-decay-lifecycle`).

#### `measurement-integrity`: Shipped (item 3)

- **Problem.** Bugs that corrupt the numbers downstream:
  - The SerpApi key-name mismatch.
  - Profound rows read as AI Overviews.
  - Dead gaps kept open.
  - Organic rows counted as citations in the refresh scan.
  - Per-asset joins that never match.
  - Double-counted clicks and overwritten crawl days.
  - Excluded and paused questions billed.
  - Duplicated clusters and sightings.
  - One bad question failing a batch, and single-step mining.
  - DataForSEO limited to 10 countries, and no vendor timeouts.
  - Profound deleting its rows before fetching.
  - Queue bugs: topicless business value, producers overwriting each other,
    cited winners rewritten.

  Customers may already have reported these numbers to their management.
- **Build.**
  - One SERP key reader.
  - Native-provider filters.
  - Gaps judged on the latest snapshot.
  - Only AI Overview citations in the refresh scan.
  - Content ids resolved from GA4 landing pages and Search Console page URLs.
  - Crawl rollups over whole UTC days.
  - Tracking-scope filters.
  - Idempotent mining in batches, with cluster reuse.
  - Tracking that skips a failing question and continues.
  - ISO location codes and vendor timeouts.
  - Queue fixes.
  - Profound fetches before it sweeps.
  - `METHODOLOGY_VERSION`, with a restatement of every moved number.
- **Done when:**
  - 0 Profound or LLM rows in native AI Overview metrics.
  - Per-asset GSC and GA4 are non-zero for at least 90% of assets with
    traffic.
  - `crawl_daily` is within 1% of the raw events.
  - 0 batch failures caused by one question.
  - Onboarding mining completes for every site.
  - 0 topicless questions above priority-1 topics.
  - 0 cited winners queued for rewrite.
  - Every partner receives a restatement note.
- **Left over.**
  - A commercial-intent classifier to replace `isQuestionLike`.
  - Re-embedding degraded vectors.
  - The weekly paid vendor-parity job.
  - The email restatement (only the in-app note exists).
  - GSC/GA4 backfill paging (`gsc-ga4-widening`).

#### `audit-correctness-fixes`: Not started

- **Problem.**
  - Robots-disallowed sampled paths fire false criticals.
  - The `bingbot` rule never matches.
  - `Blog` is flagged as deprecated.
  - `sameAs` is matched without a domain boundary.
  - Status transitions are unguarded.
  - The lead email is lost on cache hits, and audit PII is never purged.
  - Spam protection is a honeypot only.
  - The audit crawler ignores robots.txt while the page says it doesn't.
  - The copy says "visibility" for what is a readiness audit.
- **Build.** Fix each one. Add Turnstile and honour robots.txt. Say "AI
  readiness" until audit v2 measures visibility. Bump
  `RULE_REGISTRY_VERSION`.
- **Done when:**
  - 0 false critical findings on the robots fixtures.
  - 0 leads lost.
  - PII purged on schedule.
  - 0 robots violations.

#### `spend-governor`: Shipped (item 5)

- **Problem.** There was no LLM budget anywhere. The SERP guard read the
  month's spend, then called, with no lock, and failed silently. Model calls
  carried no run or opportunity id, so cost per article could not be known.
- **Build.**
  - Budgets, counters and reservations.
  - Reserve-then-settle with one atomic conditional update, at the
    `runJsonTask` and `cachedCall` boundaries.
  - A typed `BudgetExceededError`, and alerts at 80% and 100%.
  - A per-article cap.
  - Run and opportunity ids, cache tokens and the stop reason on
    `ops.llm_calls`.
  - Longest-prefix pricing.
  - Headroom shown to staff and customers.
- **Done when:**
  - No org exceeds a cap by more than one request's cost.
  - Every model call carries a run and opportunity id.
  - Alerts arrive within 5 minutes.
  - Cost per article is visible per run.
- **Left over.**
  - The 3× trailing-median anomaly alert.
  - A `paused_budget` autonomy state.
  - A site or article budget UI (the schema already supports site budgets).
  - A `profound` resource.
  - Audit model calls (`lib/audit`, both the public audit and in-app runs)
    and embedding calls are outside the governor.

#### `pipeline-hardening`: Not started

- **Problem.**
  - There is no `onFailure` handler, and some steps throw before the try
    block.
  - A failed dispatch is not reverted, and nothing reaps stuck rows.
  - A double submit creates two items.
  - The `cancelOn` events do not exist.
  - `routeTo: brief` fails the run instead of regenerating the brief.
  - The draft step bundles the model call with DB writes.
  - A site with no author fails forever.
  - Failed sources are re-offered to the drafter.
  - Titles may be 120 characters, and internal-link URLs can be relative.
  - Opening a gate is not idempotent.
  - The Slack mention and the approval copy are wrong.
- **Build.**
  - An `onFailure` handler that marks the opportunity failed with a reason.
  - A concurrency key per opportunity plus a DB compare-and-set. Not Inngest
    idempotency, which would silently drop a legitimate re-dispatch for 24
    hours.
  - `opportunity/dismissed`, `site/paused` and `autonomy/paused` events wired
    to `cancelOn`.
  - Regenerate the brief once on `routeTo: brief`.
  - One step per model call, with DB writes in their own steps.
  - Revert a failed dispatch, add a reaper, and make gate opening idempotent.
  - Organization-as-author when no real author exists. Never invent a
    person.
  - Drop failed sources, cap titles at 110 characters, and make link URLs
    absolute.
  - Fix the Slack mention and the copy.
- **Done when:**
  - At least 99% of runs reach a terminal state without manual cleanup.
  - 0 duplicate items per opportunity.
  - 0 duplicate `llm_calls` rows from retries.
  - Dismissing or pausing cancels in-flight runs within 1 minute.
  - 0 synthetic bylines.

#### `publish-safety-kit`: Shipped (item 8)

- **Problem.** One page per question is the scaled-content pattern Google
  warns against.
  - Nothing checked existing coverage.
  - There was no velocity budget.
  - `brandFit` was a neutral 50.
  - Every page got an FAQ.
  - Untrusted text reached prompts, and nothing scanned for hidden text or
    instructions.
- **Build.**
  - A pre-brief coverage check: an owned top-10 result or featured snippet, a
    CMS title match, or website similarity of at least 0.85. A hit turns
    new-page work into a refresh or a setup task.
  - A weekly per-site publishing budget of max(2, min(5, 1.5 × trailing
    cadence)), refreshes included.
  - A topical-fit floor that produces a real `brandFit`.
  - A pre-publish scan for emails, internal entities, deal figures,
    instruction strings, zero-width characters and hidden text. A finding
    puts a person in front of the draft.
  - FAQ only with People Also Ask evidence.
- **Done when:**
  - 0 new URLs for questions with an owned top-10 result, snippet or similar
    page.
  - 0 sites over budget.
  - 0 off-topic drafts reach a human.
  - 0 internal-entity or injection strings published.
- **Left over.**
  - Generation hygiene (prompts see only verified public facts, and untrusted
    text is passed as quoted data) is an open risk.
  - Unlocking the Managed plan's 3–4 articles a week at a cohort index rate
    of 80% or more needs index data (`gsc-ga4-widening`).

#### `gsc-ga4-widening`: Not started

- **Problem.**
  - Search Console queries are filtered to the proxy prefix, and query×page
    is never pulled.
  - The 16-month backfill restarts daily.
  - There is no URL Inspection, so "not indexed" looks like "not cited".
  - GA4 is prefix-filtered, requests the deprecated `conversions` metric, and
    misses newer engines.
- **Build.** Search Console:
  - Site-wide date×query.
  - date×query×page in a partitioned `measure.gsc_query_page` table.
  - searchAppearance, country and device.
  - Month-window paging with a resume token.
  - URL Inspection at +2 and +7 days, by cohort.
  - A brand-regex query series.

  GA4:
  - `keyEvents`.
  - No prefix filter.
  - A data-driven AI referrer table.
  - AI referrals labelled as a floor.
- **Done when:**
  - The backfill completes without restarting for every property.
  - query×page exists for every Search Console site.
  - Index verdicts exist for at least 90% of platform URLs by day 7.
  - AI-referral sessions are tracked site-wide on every GA4 site.

#### `answer-ledger-schema`: Shipped (item 7)

- **Problem.** Snapshots had no engine, and there was no `ai_mode` or
  `llm_answer` surface. Profound wrote other engines as AI Overviews. There
  was nowhere to record samples, paraphrases, method, model version or
  mentions.
- **Build.**
  - Engine, model version, collection method, sample index, paraphrase id,
    run id, answer text and hash, and `citations_observable` on snapshots.
    Collection methods: `serp`, `ui_scrape`, `api_probe`, `first_party`,
    `third_party`.
  - `measure.answer_mentions`.
  - Profound backfilled as `third_party`, on each engine's own surface.
  - The `v_native_aio` and `v_answer_observations` views, which every read
    model uses.
  - Engine and sample in the cache key.
- **Done when:**
  - Every snapshot carries an engine, method and run id.
  - 0 non-Google rows on `ai_overview`.
  - Every metric read model reads the views.
  - Mentions are written within an hour for at least 95% of answers.
- **Deviations.** The views keep cached rows: the SERP and answer caches are
  shared across tenants, so a cached row is often a site's only measurement
  that day. There is no `persona_id`, `measurement_runs` or `page_kind` yet,
  and the raw-JSON retention purge is deferred.

#### `truthful-outcome-ledger`: Not started

- **Problem.**
  - The per-asset AI Overview baseline is structurally 0.
  - The "now" window is the last 30 days, not the 30 days after publish.
  - Any bot fetch counts as lift.
  - The post-publish check reads "AI Overview not triggered" as a loss, and
    any owned URL as a win.
  - Window outcomes live only in Inngest output.
  - `serp/track.completed` carries no question ids to wait on.
- **Build.**
  - `measure.content_outcomes`, per item, question, engine and horizon:
    presence with an interval, rank, GSC, AI sessions, live fetches, and a
    verdict of won, lost, inconclusive or not_indexed.
  - `citationStatus` rewritten:
    - It reads the native views.
    - It accepts only evidence from after the window start.
    - It returns inconclusive when the evidence is stale or the AI Overview
      did not trigger.
    - It decides ownership by content id, not by domain.
  - Inline single-question snapshots for the baseline and each window.
  - A daily `measure-outcomes` cron at +14, +30 and +60 days, then monthly.
    It opens at most one refresh row per item, and only on a "lost" verdict.
  - Attribution reads the ledger.
- **Done when:**
  - Every window is persisted.
  - 0 refreshes opened from inconclusive or stale evidence.
  - Losses after day 60 re-enter the queue within 7 days.
  - At most one open refresh row per item.

#### `source-role-ledger`: Shipped (item 6)

- **Problem.** Every cited domain the customer did not own was a competitor:
  in leaderboards, in scoring (+10 gap and +8 difficulty each) and in the
  structural targets briefs were told to beat. Competitor entities had no
  domains.
- **Build.**
  - `domains[]` on entities.
  - `measure.source_domains`: 13 roles and a seeded catalogue.
  - Per-site overrides.
  - `source_role` on citations.
  - One precedence: owned, then override, then competitor entity, then
    catalogue, else unknown.
  - The registry is seeded from topics, and a person confirms it.
  - Read models filter to `competitor`.
  - Strategy is split into "Competitors" and "Sources shaping answers".
- **Done when:**
  - Every active site has a confirmed competitor set.
  - 0 UGC, review or reference domains on competitor leaderboards.
  - At least 90% of recent citations have a known role.
  - The citation gap no longer grows with UGC domains.
- **Left over.** A model fallback classifier for unknown domains. Parsing
  Profound's `competitors_mentioned`. `page_kind`.

#### `event-consumers-observability`: Not started

- **Problem.** Eleven emitted events have no consumer:
  - Newly tracked questions wait up to 7 days for a first snapshot.
  - Verified sites are not scanned.
  - Revoked grants only turn a card red.
  - Failed pipelines are hidden.

  Crons are chained by wall-clock time, there is one heartbeat, and the agent
  writes nothing to `app.audit_log`.
- **Build.**
  - Consumers for `demand/mine.completed`, `site/verified` and
    `serp/track.completed`.
  - `content/pipeline.failed` raises an alert and creates a repair-queue row.
  - A failed connector sync raises an alert with a re-auth link. Transient
    failures do not set `error`.
  - Per-function heartbeats with stale alerts.
  - `actor='agent'` audit rows and a "What the agent did" list.
  - Fact extraction on `concurrencyCap`.
  - Later: one trace id across the pipeline, model calls, QA, approvals and
    publish.
- **Done when:**
  - Every event has a consumer or a documented reason.
  - The first sample arrives within 1 hour of tracking.
  - Every cron has a heartbeat.
  - Every agent action is in the activity log.
  - Auth failures alert within 1 hour.

#### `onboarding-readiness-gate`: Not started

- **Problem.**
  - Many B2B zones block OAI-SearchBot, ChatGPT-User or PerplexityBot at
    Cloudflare before the proxy sees the request.
  - Nothing checks `nosnippet` or `max-snippet`.
  - The install gives no linking guidance. An unlinked vendor subfolder in
    vendor chrome is the site-reputation-abuse pattern, and it inherits no
    authority.
  - Mining starts only when someone types keywords.
- **Build.**
  - Crawler probes of the live homepage, pricing and docs, at onboarding and
    weekly, with an optional read-only Cloudflare token.
  - A snippet-directive audit.
  - A site-integration gate before the first publish:
    - The hub is linked from the nav or footer and from a product page.
    - Pages use the customer's own header and footer.
    - At least one real employee author exists.
    - Topics are in the product category.
    - Main-domain inlinks are tracked.
  - Customer attestation that Search Console's generative-AI setting is on
    and that manual-action emails reach a monitored inbox.
  - Seed keywords from the onboarding profile.

  The gate blocks publishing, not measurement.
- **Done when:**
  - Crawler blocks and snippet limits are detected before the first publish
    on every site.
  - Every publishing site passes the gate.
  - Median of at least 3 main-domain inlinks to the hub by day 30.

#### `enterprise-trust-pack`: Not started

- **Problem.** None of these exist:
  - SAML, OIDC or SCIM.
  - Approver or legal roles.
  - SOC 2, a DPA, a sub-processor list or a no-training commitment.
  - Retention controls for Slack and MCP data.
  - An SLO, a status page or an exit plan.

  "What happens to 200 pages if we churn" decides renewal.
- **Build.**
  - SSO and SCIM, with viewer, editor, approver, legal-approver, admin and
    owner roles.
  - SOC 2 Type I readiness, with a dated Type II commitment.
  - A DPA, a sub-processor list, a no-training clause, configurable retention
    and an annual penetration test.
  - A 99.95% SLO with a p95 TTFB budget, a status page, synthetic checks and
    an incident policy.
  - An export of every page as HTML and Markdown, with JSON-LD, history and a
    redirect map. Pages keep serving for N days after cancellation, or are
    handed to the customer's CMS.
- **Done when:**
  - SSO and SCIM are GA by 2027-01-31.
  - SOC 2 Type I by 2027-03-31.
  - The DPA and sub-processors are published.
  - The SLO is met 3 months running.
  - A 500-page export completes in under 10 minutes.
  - 0 design-partner deals lost on InfoSec review.

### Phase 2: Visibility intelligence

**Goal.** Give the customer a scoreboard they own and believe, on the engines
that matter for B2B:

- A frozen panel and native sampling with honest cluster-level statistics.
- A week-1 baseline, a visibility home and a QBR export.
- The competitor organic gap, an earned target list and an accuracy judge.
- Pipeline attribution v1.

Along the way, build what Phase 3 depends on: the model runtime, unit
economics, the page inventory, the unified scorer and the eval core.

**Exit, engineering:**

- AI Overviews, AI Mode, ChatGPT (UI), Perplexity and Gemini are sampled
  natively for every frozen-panel intent, with Claude as a diagnostic.
  *Open decision:* this criterion assumes UI capture. With engine sampling
  through OpenRouter only, the ChatGPT series is an API probe, so the
  criterion has to be restated.
- Every visibility number carries n and a cluster-level interval.
- Collector health is monitored, with at least two collectors where possible.
- Sampling plus LLM cost is at or below 20% of plan price.
- Every site has a confirmed competitor set and a weekly
  recommendation-share series.
- 0 UGC or review domains on competitor leaderboards.

**Exit, customers:**

- At least three partners have used the QBR export with their executives.
- At least one partner sees pipeline attribution.
- Every new site gets its week-1 baseline within 7 days of onboarding.

| Initiative | Title | Impact · effort · confidence | Depends on | Status |
|---|---|---|---|---|
| `model-runtime-core` | SDK, structured outputs, caching, effort, refusals, provider decision | 4 · M · high | pipeline-hotfix, spend-governor | Not started |
| `plan-entitlements-unit-economics` | Plan entitlements and unit economics before sampling at scale | 4 · S · high | spend-governor | Not started |
| `reporting-panel-governance` | Customer-owned frozen reporting panel, separate from discovery | 4 · S · high | answer-ledger-schema | Not started |
| `published-surface-hygiene` | Headers, duplicates, extraction structure, honest freshness, IndexNow | 4 · M · high | takedown-kill-switch | Not started |
| `native-multi-engine-sampling` | Paraphrase panels, cluster-level statistics, redundant collectors | 5 · L · medium | answer-ledger-schema, spend-governor, plan-entitlements-unit-economics, reporting-panel-governance | Partly (item 7) |
| `baseline-report-visibility-home-v0` | Week-1 baseline, visibility home v0, weekly digest, CSV export | 5 · M · high | native-multi-engine-sampling, source-role-ledger, onboarding-readiness-gate | Not started |
| `competitor-organic-gap` | Competitor organic gap and organic share of voice | 5 · M · high | source-role-ledger, spend-governor | Partly (item 9) |
| `unified-scorer-v0` | One expected-value scorer across every producer | 5 · S · medium | measurement-integrity, source-role-ledger | Shipped (item 8) |
| `page-inventory` | Whole-site inventory, including docs and help centres | 4 · M · high | gsc-ga4-widening | Not started |
| `eval-harness` | Eval core, seeded by hand, grown from approvals | 4 · M · high | model-runtime-core | Not started |
| `earned-target-list` | Third-party pages shaping answers for commercial prompts | 4 · S · high | source-role-ledger, native-multi-engine-sampling | Not started |
| `answer-judge-accuracy` | Positioning and brand-accuracy judge, with correction at the source | 5 · M · medium | answer-ledger-schema, native-multi-engine-sampling, source-role-ledger, model-runtime-core | Not started |
| `demand-ground-truth` | AI prompt volume, persona and branded-comparative prompts | 4 · M · medium | measurement-integrity, gsc-ga4-widening | Not started |
| `pipeline-revenue-attribution` | HubSpot, then Salesforce, pipeline attribution | 5 · L · medium | gsc-ga4-widening, truthful-outcome-ledger | Not started |
| `sov-visibility-home` | Share-of-voice rollups, answer explorer, QBR export, warehouse sync | 5 · M · high | baseline-report-visibility-home-v0, reporting-panel-governance, native-multi-engine-sampling | Not started |
| `first-party-calibration-imports` | Optional Bing AI Performance and GSC generative-AI CSVs | 3 · S · medium | gsc-ga4-widening, answer-ledger-schema | Not started |
| `fanout-coverage-engine` | Query fan-out intelligence and coverage per cluster | 4 · L · medium | native-multi-engine-sampling, gsc-ga4-widening | Not started |
| `retrieval-telemetry` | One bot catalogue, verified user-triggered fetches, leading indicators | 3 · M · medium | measurement-integrity, security-hardening | Not started |
| `audit-v2-monitored` | Evidence-weighted readiness, monthly audits, findings become work | 3 · M · high | audit-correctness-fixes, model-runtime-core | Not started |
| `measurement-tiering` | Value tiers, pruning and weekly re-mining | 3 · S · high | spend-governor, answer-ledger-schema | Not started |

#### `model-runtime-core`: Not started

- **Problem.** Every model call is a raw fetch, with JSON parsed by walking
  brackets, and there is no prompt caching. OpenRouter is preferred whenever
  its key is set. But structured outputs, cache breakpoints, Batches, web
  search and refusal fallbacks are features of the direct Anthropic API.
  Audit calls are not metered. Item 1 already added effort, stop reasons,
  fallbacks and the current default models to the existing client.
- **Build.**
  - `@anthropic-ai/sdk`, with structured outputs for every `runJsonTask`
    schema.
  - No forced `tool_choice`, and an explicit effort per task.
  - Claude tasks go direct. OpenRouter stays only as an outage fallback for
    schema-validated JSON.
  - Streaming inside `step.run`.
  - A cached per-site prefix: system prompt, manifesto and verified facts.
  - Batches only for evals and backfills.
  - Metered audit calls, and the site's locale in prompts.
- **Done when:**
  - Schema-failure retries below 2%.
  - Cache reads are at least 50% of input tokens on brief, draft and judge.
  - Cost per article falls at least 40% at an equal or better golden-set
    score.
  - Every audit call is metered.

#### `plan-entitlements-unit-economics`: Not started

- **Problem.** Pro is $299 a month for 250 questions. The draft sampling plan
  (about 42,000 samples a month) would cost roughly $200–1,250 a month per Pro
  site. Entitlements exist only as text.
- **Build.**
  - Tier engines, paraphrases, samples and cadence by plan, counting only
    frozen-panel intents.
  - Enforce caps on sites, panel intents, runs and articles per week.
  - Target platform cost at or below 20% of price.
  - An ops unit-economics view.
  - Align plan copy with what ships.
- **Done when:**
  - Platform cost is at or below 20% of price for every org.
  - 0 orgs above their entitlements.
  - Plan copy matches shipped features.

#### `reporting-panel-governance`: Not started

- **Problem.** A vendor that picks the prompts and also writes for them is
  grading its own homework. Re-mining keeps changing the denominator, so
  trends become unreadable.
- **Build.**
  - `measure.prompt_panels` (version, quarter, draft/approved/frozen,
    approver).
  - `panel_items` (intent, 3–5 paraphrases, persona, funnel stage, weight,
    audit slice).
  - Approval in the app. Panels are frozen per quarter, with every change
    logged.
  - A 10–15% audit slice.
  - A separate discovery panel that proposes next quarter's items.
- **Done when:**
  - Every active site has an approved, frozen panel.
  - 0 silent rebases.
  - Every panel has an audit slice.

#### `published-surface-hygiene`: Not started

- **Problem.** The ETag quoting was fixed in item 4. Still open:
  - No `Last-Modified` header.
  - `.md` twins and `llms-full.txt` can be indexed as duplicates.
  - `trailing_slash='always'` is broken.
  - No heading ids, visible sources list or `<main>` landmark.
  - `dateModified` is bumped on every republish.
  - No IndexNow.
  - No user-agent parity test.
  - A false "merge" claim for the llms files.

  Cut from the draft:
  - `Accept: text/markdown` negotiation, because of cache cross-serving and
    cloaking exposure.
  - A 304 KPI.
  - `Content-Signal` as a header.
- **Build.**
  - One header choke point: `Last-Modified` from `content_changed_at`,
    `Link: rel=canonical` on `.md`, and `X-Robots-Tag: noindex` on
    `llms-full.txt` and the feed.
  - File extensions exempt from trailing-slash normalisation.
  - Heading ids, a TOC only on long pages, a numbered Sources list and
    `<main>`.
  - `content_changed_at` changes only on a material diff.
  - IndexNow v1 for proxied URLs.
  - A CI test that browsers and crawlers get byte-identical HTML.
  - Paginated `llms-full.txt`.
  - A structured-data policy: no self-serving ratings, no HowTo, and FAQPage
    only for a visible, evidenced FAQ.
- **Done when:**
  - 0 `.md` or `llms-full` URLs indexed.
  - Every `dateModified` change matches a material diff.
  - Every proxied publish is pinged.
  - Median time from publish to first bingbot fetch under 48 hours.
  - The parity test passes on every deploy.

#### `native-multi-engine-sampling`: Partly (item 7)

- **Problem.** Only one engine was measured natively, with one sample per
  question. Answers change on almost every run, and wording changes them more
  than repeat runs do. At n = 3 per prompt, intervals are about ±40 points.
  API answers and consumer-app answers diverge.
- **The analysis's build.**
  - An answer-engine provider routed through `cachedCall` and the governor.
  - v0: SerpApi AI Mode, DataForSEO ChatGPT UI capture, and Perplexity.
  - v1: Gemini, Claude as a labelled diagnostic, Copilot from Bing's CSV, and
    Grok and Meta via Profound.
  - 3–5 paraphrases × 1–2 samples, with a cluster-level bootstrap and paired
    differences against the top rival.
  - At least two collectors per engine, and a collector-health monitor.
  - UI, API and third-party series are never blended.
- **Shipped (item 7).** The owner decided that engine sampling goes through
  OpenRouter only.
  - The models behind ChatGPT, Perplexity, Gemini and Claude are probed
    through OpenRouter with web search on. Each series is labelled
    "API-grounded probe, not the consumer app".
  - Weekly on Tuesdays, and off per org until staff turn it on.
  - Up to 25 tracked prompts per site, with 1–3 samples each.
  - Probes go through the answer cache and the `answer_probe` budget.
  - Recommendation Share and Citation Share per engine, with 95% Wilson
    intervals, never blended with other sources.
- **Left over.**
  - AI Mode.
  - UI capture, which is not planned under the OpenRouter-only decision.
  - Paraphrase panels (the column exists).
  - The cluster-level bootstrap.
  - Redundant collectors and the health monitor.

  Model slugs and response shapes are tested with fakes. Confirm them against
  OpenRouter's `GET /api/v1/models` after deploy.
- **Done when:**
  - Five engines are sampled for every panel intent.
  - The median cluster-level 90% interval half-width is at most 12 points.
  - Collector outages are detected within 24 hours.
  - Within budget, with 0 silent stops.

#### `baseline-report-visibility-home-v0`: Not started

- **Problem.** There is nothing a VP can show their CEO. The home page is an
  install console, there is no moment where value appears, and sales has no
  demo artifact.
- **Build.**
  - A week-1 baseline report, as an HTML link and a PDF, covering 30–50 panel
    intents:
    - Native AI Overviews and AI Mode, plus the other engines.
    - The top five named competitors, recommended vs merely listed.
    - The top accuracy errors about the brand.
    - CDN crawler blocks and snippet limits.
    - A 90-day plan from the scorer, reviewed by a strategist.
  - Visibility home v0 becomes the default page, with CSV export, and
    Overview becomes "Setup".
  - A templated weekly digest.
  - Fix the "Tracked questions" and topic "published" KPIs.
- **Done when:**
  - Every new site gets the report within 7 days.
  - Executives open the digest at least 60% of the time.
  - KPIs agree across pages.

#### `competitor-organic-gap`: Partly (item 9)

- **Problem.** Nothing showed what named rivals rank for that the customer
  does not. That is the fastest route to the BOFU demand rivals already win.
  There was also no rank or organic share-of-voice series.
- **The analysis's build.**
  - DataForSEO Labs `ranked_keywords`, `domain_intersection` and SERP
    competitors per named rival, through the governor.
  - Competitor-sourced questions with volume and difficulty, BOFU first.
  - An owned rank read model with striking distance at positions 4–20.
  - Organic share of voice and top-3 share.
- **Shipped (item 9).**
  - `ranked_keywords` for up to five named competitors plus the site, monthly
    and on demand. Cached for the month and paid from the SERP budget.
  - A gap where a rival ranks in the top 10 and the site does not, with
    positions 11–20 flagged as striking distance and buyer intent first.
  - Competitor questions carrying volume, difficulty and intent.
  - The top 50 above the topical floor queued as EV0 opportunities.
  - A "Keywords they rank for that you don't" card.
- **Left over.** `domain_intersection`, the SERP-competitors endpoint, an
  owned rank read model, and organic share of voice and top-3 share.
- **Done when:**
  - A gap list exists for every named competitor.
  - Organic share of voice is tracked weekly.
  - At least 25% of new opportunities come from competitor gaps on
    established sites.

#### `unified-scorer-v0`: Shipped (item 8)

- **Problem.** Five producers scored with incompatible formulas and were then
  sorted together.
- **Build.**
  - EV0 = demand × intent weight × gap-type prior × business value × topical
    fit ÷ effort of the action.
  - Demand comes from search volume, else Search Console impressions, else
    the mined score flagged as a cold start.
  - An `action_type` enum.
  - Producers merge their evidence into one row.
  - The full breakdown is stored, and dismissals carry a reason.
- **Done when:**
  - Every opportunity is on one scale.
  - Every dismissal has a reason.
  - A strategist agrees with the top-10 order at least 70% of the time on
    partner sites.
- **Left over.**
  - Intent-keyed opportunities (the `opportunityKey` seam exists).
  - Money-page proximity in business value.
  - Fan-out as an input.
  - Calibrated priors (`expected-value-scoring`). Predicted lift is null
    until then.

#### `page-inventory`: Not started

- **Problem.** The website connector crawls 20 pages into brand-brain chunks,
  not into a URL inventory. BOFU prompts are answered from money pages and
  docs, which the platform cannot see.
- **Build.**
  - A sitemap-driven inventory of the whole site, including docs and help
    subdomains, into `cms_items` with provider `crawl`.
  - Page kinds, embeddings and money-page tags (pricing, demo, security,
    integrations).
  - A flag for pages that only render client-side.
  - Weekly refresh, joined to Search Console query×page.
- **Done when:**
  - At least 90% of sitemap URLs are inventoried.
  - Money pages are tagged on every site.
  - Docs and help pages are included where they exist.

#### `eval-harness`: Not started

- **Problem.** There are no regression or capability evals. There is also
  almost no approval history to mine, because gates never resolved.
- **Build.**
  - Golden sets per stage (brief, draft, QA judge, answer judge, policy):
    20–50 hand-labelled cases each, growing from every "changes" or
    "regenerate" decision and every inline edit.
  - Code graders first, then calibrated single-dimension judges with an
    "unknown" option, running on a different model from the one graded.
  - Capability and regression suites on recorded fixtures in CI.
  - A prompt or model change merges only when regression passes.
  - pass^3 eligibility on the safety gates.
- **Done when:**
  - At least 50 cases per stage.
  - Every prompt and model change passes regression before merge.
  - Judge agreement with humans of at least 85%.

#### `earned-target-list`: Not started

- **Problem.** The most valuable earned-media artifact is a query over data
  the platform already pays for, and it arrived late in the draft plan.
- **Build.** Per engine, the third-party URLs cited for commercial prompts
  where at least two named rivals appear and the brand does not. Each entry
  carries:
  - Role and page kind.
  - Citation frequency over 30 days.
  - The prompts and engines citing it.
  - The rivals it lists.
  - When it was last updated.
  - A public byline or contact.
  - Pay-to-play signals.

  Exported to CSV and Slack, and included in the baseline report and QBR. The
  "Sources shaping answers" card (item 6) is the starting point.
- **Done when:**
  - A list exists for every site with a commercial panel.
  - Partners act on at least 30% of their top-20 targets within a quarter.

#### `answer-judge-accuracy`: Not started

- **Problem.** Positioning was present-or-absent only. Item 7's deterministic
  `mentions-v0` adds list rank and recommended vs listed. Still missing:
  sentiment, attributes, and accuracy against verified facts. "ChatGPT says
  we don't integrate with Salesforce" loses deals.
- **Build.**
  - A judge on a small model, with structured outputs and a deterministic
    pre-pass for mentions, prices and integrations.
  - Per mention: sentiment, recommendation status, list rank, claims, and an
    accuracy verdict against verified facts ("unknown" allowed).
  - Calibration on 200 labelled answers per release.
  - Wrong claims traced to the cited URLs that contain them.
  - Accuracy and positioning opportunities.
  - A view of what each engine says about the brand and about each rival.

  `answer_mentions` already has the judge columns.
- **Done when:**
  - Kappa of at least 0.7 on recommendation status.
  - A median of at most 7 days from a persistent hallucination to an opened
    correction.
  - Recommendation rate reported separately from citations on every panel.

#### `demand-ground-truth`: Not started

- **Problem.** `demand_score` is a heuristic with no volume behind it, and
  each source uses a different scale. GSC queries are never promoted into the
  graph. There are no persona or branded-comparative prompts. Item 8 added the
  volume, difficulty and intent columns, and item 9 fills them for competitor
  keywords.
- **Build.**
  - AI keyword volume, Keywords Data and Labs difficulty, through the cache
    and the governor.
  - LLM Mentions for category prompts where rivals appear and the brand
    doesn't.
  - Nightly promotion of GSC queries.
  - Persona prompts from the ICP.
  - Auto-seeded branded and comparative prompts.
  - `demand_score` v2 on a 0–100 scale, with per-source confidence.
  - Funnel stage and intent.
- **Done when:**
  - At least 70% of panel intents carry an external volume or impression
    signal.
  - BOFU makes up at least 25% of each panel.
  - `demand_score` v2 has a Spearman correlation of at least 0.5 with GSC
    impressions.

#### `pipeline-revenue-attribution`: Not started

- **Problem.** Attribution stops at sessions. GA4 conversions are synced but
  never read, and there is no CRM, yet the Managed plan sells closed-loop
  attribution. Buyers renew on sourced and influenced pipeline.
- **Build.**
  - A shared OAuth2 layer.
  - HubSpot (contacts, companies, deals, forms), then Salesforce.
  - GA4 AI-referral sessions and key events joined to contacts and deals by
    landing page and time window.
  - Self-reported "how did you hear about us" answers classified.
  - Influenced pipeline per cluster, page and engine, shown with caveats.
  - Business value fed into the scorer.
- **Done when:**
  - At least one partner reports influenced pipeline by 2027-02-26.
  - At least 50% of CRM-connected sites report pipeline per cluster within
    60 days.
  - Self-reported AI attribution is captured on every connected form.

#### `sov-visibility-home`: Not started

- **Problem.** Executives need trends, proof and exports. There is no answer
  explorer, QBR pack or warehouse sync.
- **Build.**
  - `measure.visibility_weekly` on the frozen panel: recommendation share,
    cited share, cited-not-recommended, list rank, organic share of voice and
    top-3 share, and snippets. With cluster intervals and labels.
  - `measure.platform_events` from the Google Search Status Dashboard and
    model changes, shown as chart annotations.
  - An answer explorer.
  - A monthly or QBR export with fixed sections.
  - A daily warehouse sync.
  - Portfolio deltas and the evidence ladder.
- **Done when:**
  - At least three partners use the QBR export by 2027-02-26.
  - Every site has a 12-week trend with intervals.
  - At least one partner is on warehouse sync.

#### `first-party-calibration-imports`: Not started

- **Problem.** Bing AI Performance and Search Console's generative-AI report
  are the only first-party AI citation and impression data. Both are UI or
  CSV only.
- **Build.**
  - Monthly CSV imports.
  - Grounding queries used as observed fan-out.
  - A provider interface ready for future APIs.
  - A reconciler that compares sampled presence with first-party counts.

  Optional, and never a dependency for anything else.
- **Done when:**
  - Imports are available for every opted-in site.
  - The correlation between sampled presence and first-party citations is
    reported monthly.

#### `fanout-coverage-engine`: Not started

- **Problem.** In secondary studies, pages that rank for both the head query
  and its fan-out sub-queries are cited far more often than pages ranking for
  the head query alone. The platform tracks head queries only.
- **Build.**
  - Observed fan-outs (Gemini `webSearchQueries`, Bing grounding queries, GSC
    AI Mode prompts) and synthetic ones kept only when they recur.
  - `measure.fanout_edges`.
  - Organic SERP checks that give a coverage percentage.
  - A sub-query becomes a section unless its top-10 overlap with the head
    query is below 30%.
  - Which fan-outs a cited rival ranks for.
  - `fanOut[]` in briefs.

  Gemini's observed queries need the Gemini API itself; whether OpenRouter
  probes expose them is unverified.
- **Done when:**
  - Stable fan-out sets exist for the top 100 intents per site.
  - At least 60% of new briefs carry a fan-out map.
  - Fan-out-mapped articles beat matched articles in the outcome ledger.

#### `retrieval-telemetry`: Not started

- **Problem.**
  - Three bot catalogues drift apart.
  - robots.txt tokens are treated as user agents.
  - Several bot families are missing.
  - "Unverifiable" is collapsed into false.
  - Nothing joins user-triggered fetches to citations.

  Item 2's `trustedClientIp` already closed the spoofing path for origin
  telemetry.
- **Build.**
  - One catalogue, generated into the Worker and the audit.
  - The missing families added.
  - Tri-state verification, with reverse DNS.
  - Human AI-referral clicks recorded in the Worker.
  - Read models: retrieval-to-citation rate, publish-to-first-fetch time,
    and tier-1 error anomalies.
- **Done when:**
  - Retrieval-to-citation rate exists for every published page.
  - 0 spoofed verified live fetches.
  - Tier-1 crawler error spikes alert within 1 hour.

#### `audit-v2-monitored`: Not started

- **Problem.**
  - Schema carries 15% of the score and llms.txt about 7 points, against
    the controlled evidence.
  - Training-bot opt-outs are penalised as critical.
  - The monthly audit that Starter sells is never scheduled.
  - Findings feed nothing downstream.
- **Build.**
  - Re-weight: schema at most 5% as hygiene, llms.txt at 0%. The weight moves
    to the answer-first lede, self-contained chunks, substantive freshness,
    client-side-rendering exposure, original data and third-party
    corroboration.
  - Score search and live-fetch bots by default.
  - Monthly monitored audits, with diffs.
  - Findings become opportunities with fix snippets.
  - The public snapshot runs behind Turnstile, with its own budget.
- **Done when:**
  - Monthly audits run for every Starter-and-above site.
  - At least 30% of findings become work.
  - The rule registry version is bumped with release notes.

#### `measurement-tiering`: Not started

- **Problem.** Cadence is set by hand. The tracked set only grows, there is no
  re-mining, and paid mining results are thrown away.
- **Build.**
  - Nightly value tiers (weekly, biweekly, monthly).
  - Demote and untrack questions after 8 weeks with no AI presence.
  - `measure.tracking_plan`, with a reason for every change.
  - A weekly re-mine.
  - Persist paid mining results as baseline snapshots.

  The frozen panel's cadence stays fixed by plan.
- **Done when:**
  - Net tracked-set growth per re-mine is close to 0.
  - SERP cost per tracked item stays flat as sites grow.

### Phase 3: Senior-strategist execution

**Goal.** Work like a senior SEO/AEO director:

- One canonical URL per intent, keyed on SERP overlap.
- Briefs that beat the current answer, with first-party information gain.
- QA that checks claim truth and passage citability.
- A money-page and docs workstream.
- An entity-correct surface, with real experts, hubs and links.
- A lifecycle that protects winners and auto-reverts refreshes that make
  things worse.
- An earned-media program within link-scheme and FTC rules.
- A quarterly campaign plan that humans approve.
- Lift proven with stepped-wedge comparisons against not-yet-treated
  clusters.

All of it runs behind a full spam-policy governor with an index-health
circuit breaker.

**Exit, engineering:**

- 0 new URLs for intents that already have a live owned URL.
- At least 50% of actions are not new pages on established sites (at least
  20% on new sites).
- Every brief carries an answer to beat, at least three verified
  information-gain items (at least one first-party), and a fan-out map where
  available.
- An unsupported-claim escape rate below 1% in monthly audits.
- Every page has a real byline, a reviewer, and an Organization `@id` with
  `sameAs`.
- Earned citation share is tracked per engine.
- A simulated subfolder collapse trips the breaker within 48 hours.
- Every comparison and alternatives page has a methodology section and
  sourced competitor facts.

**Exit, customers:**

- Pooled lift against not-yet-treated clusters is reported with a confidence
  interval for the partner cohort.
- Every partner has an approved quarterly campaign plan.

| Initiative | Title | Impact · effort · confidence | Depends on | Status |
|---|---|---|---|---|
| `intent-clusters-cannibalization` | One canonical URL per intent cluster, SERP overlap first | 5 · L · high | pipeline-hardening, page-inventory, gsc-ga4-widening, publish-safety-kit | Not started |
| `brief-v3-formats-bofu` | Formats from SERP evidence, funnel stage, BOFU types, doorway guardrails, brief lint | 5 · M · high | pipeline-hardening, demand-ground-truth, intent-clusters-cannibalization | Not started |
| `research-information-gain` | Answer to beat, consensus vs missing angles, first-party information gain | 5 · L · medium | brief-v3-formats-bofu, source-role-ledger, model-runtime-core, publish-safety-kit | Not started |
| `qa-v2-truth-citability` | Claim truth, originality and passage citability | 5 · L · high | pipeline-hardening, brief-v3-formats-bofu, eval-harness | Not started |
| `refresh-decay-lifecycle` | Protect winners, refresh decliners with auto-revert, consolidate, prune | 5 · L · high | intent-clusters-cannibalization, truthful-outcome-ledger, takedown-kill-switch, page-inventory | Not started |
| `money-page-main-site-workstream` | Recommendations and tickets beyond the blog | 5 · M · medium | page-inventory, answer-judge-accuracy, brief-v3-formats-bofu | Not started |
| `entity-schema-graph` | One resolvable brand entity, site graph, re-materialisation | 4 · M · high | published-surface-hygiene | Not started |
| `eeat-expert-input` | Real authors and reviewers, SME interviews, publishable facts | 4 · M · medium | pipeline-hardening, entity-schema-graph | Not started |
| `hubs-internal-link-graph` | Hubs and an internal-link graph routed to money pages | 4 · L · medium | intent-clusters-cannibalization, published-surface-hygiene, page-inventory | Not started |
| `citation-gap-typing` | Extractability, coverage, earned, accuracy, retrieval-blocked | 5 · M · medium | source-role-ledger, native-multi-engine-sampling, competitor-organic-gap | Not started |
| `publish-safety-governor` | Index-health breaker, cross-tenant originality, update freezes | 5 · L · high | publish-safety-kit, qa-v2-truth-citability, gsc-ga4-widening, takedown-kill-switch | Not started |
| `causal-lift-holdouts` | Stepped-wedge DiD pooled across tenants, with confidence labels | 5 · L · medium | truthful-outcome-ledger, native-multi-engine-sampling, reporting-panel-governance, gsc-ga4-widening | Not started |
| `offsite-opportunity-engine` | Find, cost, draft, route and verify off-site placements | 5 · L · medium | earned-target-list, source-role-ledger, native-multi-engine-sampling, security-hardening | Not started |
| `authority-mentions-monitoring` | Mentions, referring-domain gap, branded-search lift | 4 · M · medium | source-role-ledger, spend-governor, gsc-ga4-widening | Not started |
| `campaign-ledger-quarterly-plan` | Campaign ledger and a quarterly plan humans approve | 4 · M · high | unified-scorer-v0, sov-visibility-home | Not started |
| `expected-value-scoring` | Calibrated win probabilities from pooled outcomes; queue hygiene | 4 · M · medium | unified-scorer-v0, citation-gap-typing, truthful-outcome-ledger, causal-lift-holdouts | Later |
| `section-drafting` | Section-by-section drafting with cost caps | 3 · L · high | model-runtime-core, qa-v2-truth-citability | Later, below the cut line |
| `byod-qa-publish` | Customer and agency drafts through the same loop | 3 · M · medium | qa-v2-truth-citability, truthful-outcome-ledger | Later |
| `original-data-digital-pr` | Proprietary-data studies and digital PR | 4 · L · low | eeat-expert-input, entity-schema-graph, offsite-opportunity-engine | Later, managed service first |
| `offsite-footprint-programs` | Community, LinkedIn and video repurposing, partner listings | 3 · L · medium | offsite-opportunity-engine | Later |

#### `intent-clusters-cannibalization`

- **Problem.** One page per question is what Google calls scaled content.
  `pillar_content_id` is never used. A cosine threshold of 0.88 merges
  distinct intents ("X pricing" vs "X SOC 2") while still splitting
  paraphrases. Shared top-10 URLs reflect Google's own view of intent.
- **Build.**
  - `content.page_intents` (hub, spoke or standalone; canonical URL; funnel
    stage; format).
  - Questions are assigned to an intent by shared top-10 URLs (at least 4 of
    10, tuned), with embeddings as a second signal.
  - Intents are mapped to owned URLs through the inventory, query×page and
    owned organic rows.
  - The dedupe key becomes `intent:<id>`, so work on an intent that already
    has a live URL becomes an expansion or a refresh.
  - A nightly detector flags owned URLs that split impressions.
  - Briefs see the intent's siblings, its hub and a coverage map.
- **Done when:**
  - 0 new URLs for intents that have a live owned URL.
  - Clusters that split impressions fall by at least 50% within 90 days.
  - At least 50% of actions are not new pages on established sites.

#### `brief-v3-formats-bofu`

- **Problem.** Every question gets its topic's first format. The B2B formats
  engines cite most are missing, and adding them without guardrails creates
  programmatic doorways. Self-ranked listicles backfire. Briefs reach humans
  unlinted, and a fixed skeleton fingerprints every tenant.
- **Build.**
  - BriefSpec v3: persona, funnel stage, queries, word target, money page,
    schema type, SME questions, freshness hooks, answer to beat, information
    gain and fan-out.
  - New formats: alternatives, X vs Y, pricing, integration, use case,
    industry, glossary, template and benchmark.
  - A format resolver driven by intent and the dominant cited content type.
  - Per-format doorway guardrails, plus a SERP-distinctness test before
    minting a URL.
  - BOFU guardrails: ownership disclosure, a methodology section, dated
    competitor sources, no self-#1 without evidence, and self-promotional
    listicles at 20% or less.
  - Page structure chosen from evidence, not a fixed skeleton.
  - Brief lint before the gate.
- **Done when:**
  - Change and regenerate requests on briefs fall by at least 50%.
  - Every comparison page has a methodology and sourced facts.
  - 0 templated variants published without passing distinctness.

#### `research-information-gain`

- **Problem.** There is no research step, and sources come from the model's
  memory. Stored AI Overview text, snippets, PAA answers and competitor
  headings never reach the brief. Facts are retrieved by entity, not by
  relevance. Refreshes strip verified markers. First-party data is the
  information gain competitors cannot copy.
- **Build.**
  - Persist competitor bodies and their extracted claims.
  - `lib/pipeline/research.ts` builds:
    - The answer to beat.
    - Consensus claims (present in at least 50% of cited pages).
    - Missing angles (under 20%, mapped to brand facts or ICP pains).
    - Third-party candidates from web search, each verified through
      `safeFetch`.
  - A source library, rechecked monthly.
  - At least three information-gain items, at least one first-party.
  - Facts ranked by relevance.
  - n-gram originality checks.
  - Refreshes carry their markers over.
- **Done when:**
  - Every brief carries an answer to beat and at least three gain items, at
    least one first-party.
  - 0 source failures after the brief.
  - At least 90% of prior sources survive a refresh.

#### `qa-v2-truth-citability`

- **Problem.**
  - List and table text is dropped from section checks.
  - Pages with no H2 outscore sectioned ones.
  - The numeric regex misses counts, currency and number words.
  - One marker exempts a whole paragraph.
  - Numbers are never checked against their quote.
  - Unmarked competitor claims go undetected.
  - Manifesto bans are enforced only in the prompt.
  - Links are unchecked.
  - The judge is never called, and nothing simulates retrieval.
- **Build.**
  - Rule fixes, plus lede, entity-density and self-contained-chunk rules.
  - A claims gate:
    - A marker covers only its own sentence.
    - Tables are scanned.
    - Numbers must appear in the cited quote or fact.
    - Competitor sentences need a source.
    - Testimonials need publish permission.
    - Bans are enforced in code.
    - Links must be on the allowlist and return 200.
  - n-gram originality.
  - A judge on a separate context and model, with one rubric per dimension.
  - A citability simulator per H2, and an answerability check.
- **Done when:**
  - The unsupported-claim escape rate is below 1% in a monthly 50-page audit.
  - QA false-fail rate is below 10%.
  - At least 70% of drafts are approved on the first attempt.

#### `refresh-decay-lifecycle`

- **Problem.** Refresh is Webflow-only and its only action is a rewrite.
  Posts with no data still clear the threshold. Noindex, retire and rollback
  exist since item 4, but only as manual actions. There is no consolidation,
  and nothing undoes a refresh automatically when it hurts.
- **Build.**
  - Scoring on the unified scorer:
    - A protect class (item 3 shipped a first version).
    - No neutral defaults that clear the threshold.
    - Striking distance at positions 4–20.
    - Staleness weighted by engine mix.
    - Dismissals stick for 90 days.
  - Every inventory page mapped to an intent.
  - Actions: refresh, update stats, expand, consolidate (301), noindex, and
    retire (410).
  - `content.redirects`, honoured by the renderer.
  - Auto-revert at +28 days against matched controls.
  - Fixed re-measure windows that close refreshes showing no lift.
- **Done when:**
  - 0 rewrites of protect-class pages.
  - Every harmful refresh is reverted within 30 days.
  - Refreshed pages beat their controls at +60 days.
  - Pages with zero impressions are consolidated or pruned within 30 days.

#### `money-page-main-site-workstream`

- **Problem.** BOFU prompts are answered from pricing, trust, integration and
  docs pages, not from blog posts. Pages rendered client-side are invisible
  to crawlers that don't run JavaScript.
- **Build.**
  - Per-site recommendations, backed by BOFU answers and the accuracy judge:
    - Crawlable plain-text pricing.
    - A trust centre.
    - An integration directory.
    - Comparison pages linked from the nav.
    - Fixes for pages rendered client-side.
    - Organization and product facts consistent with the brand facts.
  - Docs and help pages scored and mapped to intents.
  - Tickets exported to Slack, CSV, and optionally Linear or Jira.
  - The expected impact of each recommendation is recorded, then measured.
- **Done when:**
  - Each partner ships at least five main-site fixes per quarter.
  - Accuracy errors on pricing, security and integration prompts fall by at
    least 50% within 90 days.

#### `entity-schema-graph`

- **Problem.**
  - The publisher Organization has no `@id` or `sameAs`, and Person has no
    `@id`.
  - There are no WebSite, WebPage or SoftwareApplication nodes, and `about`
    is never filled.
  - Every page is a BlogPosting.
  - JSON-LD is frozen at publish time, and the canonical can disagree with
    the `@id`.

  The platform's own pages fail its own entity audit.
- **Build.**
  - Organization config: `@id`, verified `sameAs`, description and logo.
  - A site graph:
    - Organization and WebSite nodes.
    - SoftwareApplication with an Offer built only from verified pricing,
      and never self-serving ratings.
    - WebPage.
    - Person with an `@id`.
    - `about` and `mentions` from Wikidata.
    - ItemList, DefinedTerm and Dataset where they fit.
  - No HowTo, and a parity check against the visible text.
  - The canonical comes from the canonical domain.
  - A re-materialise job with no model call.
  - A JSON-LD slot for Webflow.
  - A read-only Wikidata audit.
- **Done when:**
  - Every page references one Organization `@id` with at least five verified
    `sameAs` links.
  - 0 canonical vs `@id` mismatches.
  - A corpus-wide schema change completes in under 15 minutes with no model
    spend.

#### `eeat-expert-input`

- **Problem.** One default author on every page, and no author management,
  reviewer or SME capture. Facts can never become public. A synthetic byline
  is an existential reputational risk.
- **Build.**
  - Author fields and a reviewer, with author management and `sameAs`.
  - A byline resolver: the author must be a real contributor or reviewer,
    with Organization-as-author as the fallback.
  - SME interviews by Slack DM: 3–5 questions, a 48-hour window, consented
    quotes.
  - Facts promotable to public with permission.
  - Author pages, a "Reviewed by" line, `reviewedBy` in the JSON-LD, and an
    editorial-policy page.
- **Done when:**
  - Every new article has a real byline and a named reviewer.
  - At least 60% carry an attributed SME quote.
  - Each site has at least 25 publishable verified facts within 30 days.

#### `hubs-internal-link-graph`

- **Problem.** The prefix root returns 404, and the breadcrumb points at it.
  There are no hubs. Links go to the 25 newest pages and never to money
  pages. There is no orphan detection.
- **Build.**
  - `published_pages.kind`.
  - The prefix index and topic hubs, generated from the page intents, with
    ItemList markup, real breadcrumbs and sitemap entries.
  - An internal-link graph.
  - A link planner that always includes a money page and varies anchors.
  - Back-links into proxy pages applied automatically (tier 0), with Webflow
    diffs on approval.
  - An orphan report.
- **Done when:**
  - The prefix root and every hub return 200.
  - 0 orphan platform pages.
  - A median of at least 8 contextual inlinks per page.
  - At least 90% of articles link to a money page.

#### `citation-gap-typing`

- **Problem.** A gap only means "AI Overview triggered and we're not cited",
  and every response is "write or refresh a page".
- **Build.** For each cluster and engine where the brand trails the top
  rival, assign one type:
  - Extractability: an owned page ranks top 10 but is not cited.
  - Coverage: no rank for the query or its fan-outs.
  - Earned: mostly UGC, review or publisher sources.
  - Accuracy or positioning.
  - Retrieval-blocked: not indexed, not fetched, or opted out.

  Each type carries evidence, plus a monthly per-engine source-mix profile.
  Item 6's source roles are the input for the earned type.
- **Done when:**
  - Every new opportunity carries a type and evidence.
  - At least 50% of opportunities on established sites are not new pages.

#### `publish-safety-governor`

- **Problem.** Vendor content in a subfolder matches the
  site-reputation-abuse pattern, and Google's November 2024 clarification says
  first-party oversight does not exempt it. Scaled-content abuse applies
  however content is made.
- **Build.**
  - Extend the kit:
    - Cross-tenant and competitor n-gram similarity.
    - A 20% cap on self-promotional listicles.
    - Forbidden formats.
    - A velocity ramp of 1.5× per 30-day cohort, only when the index rate is
      at least 80% and impressions per page clear the site median.
  - An index-health job: URL Inspection cohorts at 2, 7, 14 and 30 days, and
    subfolder vs rest-of-site impressions. Its breaker pauses publishing below
    a 70% index rate, or on a subfolder drop of more than 50% week over week,
    until a human resumes it.
  - Google update rollouts freeze ramps.
  - Pages always render in the customer's own theme; templates are never
    varied to hide the vendor.
- **Done when:**
  - 0 manual actions across tenants.
  - Cohort index rate of at least 80%.
  - A simulated collapse trips the breaker within 48 hours.

#### `causal-lift-holdouts`

- **Problem.** There is no counterfactual.
  - Permanent 15–20% holdouts are underpowered on a 20–50-cluster site, and
    they are a sales objection.
  - Proxy split tests have no power at mid-market scale.
  - A strict rule would leave clusters "inconclusive" for quarters.
- **Build.**
  - Pre-registered experiments.
  - Stepped-wedge randomisation of treatment weeks, stratified by topic and
    demand, so every cluster is eventually treated.
  - DiD on recommendation share, cited share and GSC clicks per engine, with a
    cluster bootstrap, pooled with hierarchical shrinkage and annotated with
    platform events.
  - Leading, likely and proven labels, and a monthly evidence ladder.
  - Content rules promoted only through pooled tests.
- **Done when:**
  - Pooled lift with a 90% interval is reported for the partner cohort by
    2027-06-04.
  - Every shipped action has a wave assignment.
  - At least three content rules are validated or refuted per quarter.

#### `offsite-opportunity-engine`

- **Problem.** Third-party pages dominate B2B AI citations (vendor studies,
  unverified). The platform pays to see them and never acts on them. Listicle
  inclusion is often paid. Review-site category placement and review velocity
  decide "best X software" eligibility.
- **Build.**
  - Off-site targets, actions and outcomes. Actions include listicle pitches,
    review profile and category fixes, review requests, community replies,
    LinkedIn articles, PR pitches, Wikidata suggestions, partner listings and
    link reclaim.
  - EV with an estimated cost per placement, plus pay-to-play flags.
  - Listicle parsing via `safeFetch`, respecting robots.txt.
  - A policy module where deny wins:
    - Always executed by humans.
    - No auto-posting, account management, bought reviews, undisclosed
      affiliation or Wikipedia edits.
    - Paid placements use `rel="sponsored"` or nofollow, with FTC disclosure.
    - No anchor-text outreach.
  - A named owner per action, routed to their task tool.
  - Daily placement verification and re-sampling.
- **Done when:**
  - Earned citation share rises at least 10 points per engine within two
    quarters, against not-yet-treated clusters.
  - 0 policy violations.
  - Every paid placement is disclosed.

#### `authority-mentions-monitoring`

- **Problem.** There is no mention, backlink or authority data, and
  difficulty is a proxy. Branded-search lift is invisible.
- **Build.**
  - Backlinks and content-analysis data for the brand and its rivals,
    through the governor.
  - Weekly mention and authority tables.
  - Unlinked publisher mentions become link-reclaim actions.
  - Difficulty becomes the referring-domain gap.
  - Optional Ahrefs on the customer's own key, labelled as Ahrefs data.
- **Done when:**
  - Mention velocity is tracked weekly against every rival.
  - At least 25% of unlinked publisher mentions are reclaimed within 90 days.

#### `campaign-ledger-quarterly-plan`

- **Problem.** "Win SOC 2 automation on ChatGPT by Q2" is a strategist's
  deliverable. Topics have no goal, owner, deadline or definition of "won".
- **Build.**
  - `strategy.campaigns`. Only the measurement system marks a campaign
    achieved.
  - A quarterly plan drafted from the scorer, typed gaps and rival moves,
    approved by the customer and the strategist.
  - Expected and realised lift on the plan page and decision log.
- **Done when:**
  - Every partner has an approved quarterly plan.
  - Campaigns meeting their goal by the deadline are reported quarterly.

#### `expected-value-scoring` (later)

- **Problem.** EV0's priors are set by hand.
- **Build.**
  - Refit the probability of a win monthly, from outcomes and stepped-wedge
    results, with pooled priors and per-site shrinkage.
  - Re-validate evidence before dispatch, auto-close closed gaps and expire
    stale rows.
- **Done when:**
  - A Spearman correlation of at least 0.3 between EV and realised wins after
    two quarters.
  - Median evidence age in the open queue under 14 days.

#### `section-drafting` (later, below the cut line)

- **Problem.** Every QA failure regenerates the whole article, so sections
  that already passed can regress.
- **Build.**
  - Plan sections, then draft each with its own context.
  - An editor pass, then QA.
  - Repair only the failing sections, with passing ones frozen by hash.
  - One step per model call, with a cost cap.
- **Done when:**
  - At most 1.5 QA attempts per article on average.
  - 0 regressions of passing sections.
  - Cost down 40% at an equal golden-set score.

#### `byod-qa-publish` (later)

- **Problem.** The platform runs alongside the customer's writers and agency.
  If it measures only its own pages, it is not the system of record.
- **Build.** Accept a Google Doc, Markdown or a CMS URL. Run it through QA and
  safety, publish, assign a wave, then measure and attribute it like a
  platform draft, reported separately.
- **Done when:** at least 30% of partner pages from writers or agencies are
  measured in the platform.

#### `original-data-digital-pr` (later)

- **Problem.** First-party data is information gain competitors cannot copy,
  and it earns editorial citations. Automating it end to end is
  low-confidence.
- **Build.**
  - Benchmarks from aggregate, anonymised metrics or survey CSVs, with
    k-anonymity and customer approval of every figure.
  - A data page with Dataset JSON-LD, plus quotable stats.
  - A pitch pack that a human sends.
- **Done when:**
  - At least one benchmark per managed partner per quarter.
  - At least five independent editorial mentions per study.

#### `offsite-footprint-programs` (later)

- **Problem.** Engines draw on different source mixes. Reddit's Data API
  excludes commercial use, so it cannot be a dependency.
- **Build.**
  - Cited threads found from `ugc_forum` citations, with disclosed,
    link-free reply drafts for a named employee to post.
  - A distribution pack on publish.
  - Partner-marketplace checks.
- **Done when:** at least 70% of cornerstone articles have at least one
  distribution asset placed within 30 days.

### Phase 4: Accountable autonomy (design only this round)

**Goal.** Turn the proven machinery into an agent that runs without
supervision, under policy, with autonomy earned per site and per topic. The
design is in [Autonomy design](#autonomy-design).

**Exit, engineering:**

- 0 publishes without a `policy_decisions` row.
- At least 70% of L1 actions start without a click.
- A post-hoc audit rejection rate below 5% on a 1-in-5 sample.
- 0 dispatches on closed gaps.
- The weekly memo reaches every active site.

**Exit, customers:**

- The autonomy opt-in rate is tracked per tier.
- Gross and net revenue retention on the partner cohort are reported.
- 0 autonomy-caused incidents that need a takedown.

| Initiative | Title | Impact · effort · confidence | Depends on |
|---|---|---|---|
| `risk-policy-engine` | Per-action risk policy, earned autonomy, named approvers, safe review windows | 5 · L · high | pipeline-hardening, event-consumers-observability, publish-safety-governor, eval-harness, enterprise-trust-pack |
| `autopilot-dispatcher` | Deterministic dispatcher, refresh first, re-validating evidence | 5 · M · high | spend-governor, unified-scorer-v0, risk-policy-engine, publish-safety-governor, refresh-decay-lifecycle |
| `visibility-decision-layer` | Confirm-before-alert sentinel, read-only tools, weekly strategist memo | 5 · M · high | sov-visibility-home, native-multi-engine-sampling, event-consumers-observability, unified-scorer-v0 |
| `outcome-learning-calibration` | Pooled cross-tenant priors with per-site adjustment | 4 · L · medium | causal-lift-holdouts, expected-value-scoring |
| `goal-directed-planner` | Bounded model planner in shadow mode | 4 · L · medium | autopilot-dispatcher, visibility-decision-layer, eval-harness, campaign-ledger-quarterly-plan |
| `publishing-reach` | Draft-first WordPress and HubSpot CMS adapters | 3 · L · medium | entity-schema-graph, published-surface-hygiene, pipeline-revenue-attribution |
| `customer-api-mcp` | Customer read API and read-only MCP server | 3 · M · medium | enterprise-trust-pack, visibility-decision-layer |

- **`risk-policy-engine`.** `evaluate()` returns a tier, a decision (auto,
  auto with a review window, ask, or forbid), the rule ids and a policy
  version. It is deterministic code: deny wins and errors fail closed to
  "ask". It writes an immutable `content.policy_decisions` row, and it
  carries:
  - The earned-autonomy ladder.
  - Named approvers per risk class, with SLAs, delegation and out-of-office
    fallback.
  - Freeze windows, and a notification on every publish.
  - Review through a Docs or Notion round trip.
  - An inline-edit path that creates a human version.
  - An editorial-responsibility record for EU AI Act Art. 50.

  Done when there are 0 publishes without a policy decision, median approval
  latency is under one business day, and 0 new pages are indexed before their
  review window closes.
- **`autopilot-dispatcher`.** A daily singleton per site. It picks from the
  EV queue within cadence, budget headroom, velocity and diversity (at most k
  per cluster per week), after a policy pre-check. Before dispatching it
  re-validates the evidence with an inline single-question snapshot and drops
  closed gaps. It dispatches with compare-and-set and logs every pick and
  skip. Done when at least 70% of actions on L1 sites start without a click,
  cadence holds within ±10%, and there are 0 dispatches on closed gaps.
- **`visibility-decision-layer`.** A sentinel that confirms each candidate
  change by re-sampling before raising it. Confirmed signals re-score
  opportunities. It exposes a typed, read-only tool surface, and a model
  writes a weekly strategist memo over deterministic data. Done when the
  median time from a confirmed loss to an evidence-backed opportunity is at
  most 48 hours, and false alarms are at most 20%.
- **`outcome-learning-calibration`.** Nightly learnings by action, format,
  engine, intent and funnel stage. The pooled cross-tenant prior is the
  primary learner, built from aggregate, anonymised data, with per-site
  weights shrunk toward it. Reviewer notes become proposed manifesto changes
  that a human approves. Done when the Brier score is at most 0.2, then 0.15.
- **`goal-directed-planner`.** A weekly model planner whose only write is
  `propose_actions`, from a fixed catalogue and under hard caps. It runs a
  quarter in shadow mode against the dispatcher. It is adopted per site only
  at 70% or higher acceptance and a lower cost per achieved goal, and it never
  creates or verifies facts.
- **`publishing-reach`.** A `PublishAdapter` interface that writes drafts
  first, with a throttle per target and IndexNow plus URL Inspection after
  publish. WordPress and HubSpot CMS first. Done when 2 adapters are live,
  refresh proposals are available for at least 80% of WordPress and HubSpot
  blogs, and 0 publishes bypass approval.
- **`customer-api-mcp`.** Org-scoped tokens, a read API and a read-only MCP
  server over the agent tools. The only writes go through propose and
  approve. Done when at least 15% of Growth+ customers use it within 2
  quarters of launch, with 0 security incidents.

## New agent skills

Every skill has an autonomy tier: *auto* runs on its own, *auto + notice*
runs and tells a person, *approval* waits for a person before anything
happens. The last column says what exists on this branch.

50 skills: 29 run automatically, 12 run and tell a person, 9 need an approval before anything happens.

**Measurement**

| Skill | Tier | What it does | Runs on | On this branch |
|---|---|---|---|---|
| `answer-sampler` | auto | Samples each engine natively across panel paraphrases, within plan tier and budget. | Tier schedules; re-validation requests | v0, item 7: API-grounded probes via OpenRouter, no paraphrases |
| `entity-mention-extractor` | auto | Matches brand and rival aliases deterministically in answer and AIO text. | Every recorded snapshot | v0, item 7 (`mentions-v0`) |
| `source-role-classifier` | auto | Assigns each cited domain a role (owned, competitor, UGC, review, reference, publisher, analyst, partner and so on) and labels page kind. | New unknown domain; monthly | v0, item 6: seed map and overrides, no model fallback |
| `collector-health-monitor` | auto | Watches each answer collector for parse failures, empty answers, latency and drift, and fails over to a second collector where one exists. | Every sampling run |  |
| `measurement-regression-check` | auto | Verifies vendor parity on golden queries and sanity-checks metrics before any agent cycle uses the data. Blocks cycles when parity drops. | Nightly in CI; weekly live paired job; before each dispatcher cycle |  |
| `answer-positioning-and-accuracy-judge` | auto | Grades sentiment, recommended vs listed, list rank and attributes, and checks factual accuracy against verified facts. | Nightly over new snapshots |  |
| `fanout-modeler` | auto | Derives stable sub-queries and decides whether each is a section or a distinct URL using SERP overlap. | Weekly for priority intents |  |
| `measurement-planner` | auto + notice | Assigns simple value tiers, demotes dead questions and prunes excluded ones in the discovery set. | Nightly |  |
| `first-party-reconciler` | auto | Calibrates sampled presence against Bing citations and GSC AI impressions per page. | After each optional import |  |
| `indexing-verifier` | auto | Checks index status and canonical with URL Inspection at +2 and +7 days, so 'not indexed' is told apart from 'not cited'. | +2 and +7 days after publish |  |

**Strategy and planning**

| Skill | Tier | What it does | Runs on | On this branch |
|---|---|---|---|---|
| `competitor-mapper` | approval | Proposes the named rival set (entities, domains, aliases) from onboarding data, citations and LLM Mentions co-occurrence. | Onboarding; monthly; new vendor entering the top cited set | Partly, item 6: topic domains become unconfirmed competitors |
| `competitor-organic-gap-analyst` | auto | Finds commercial keywords and pages where named rivals rank top-10 and the brand doesn't. | Weekly; new rival confirmed | v0, item 9: no organic share of voice yet |
| `coverage-guard` | auto | Before any brief, blocks new URLs for intents the site already covers and routes them to refresh or expansion. | Every pipeline start | v0, item 8 |
| `opportunity-ranker` | auto | Produces one explainable EV ranking across every producer. | After scans and confirmed signals | v0, item 8 (`ev0-2026-10`, hand-set priors) |
| `intent-cluster-planner` | auto | Maps questions to one canonical page intent, using SERP overlap first and embeddings second. | After mining; nightly |  |
| `citation-source-analyst` | auto | Types each gap (extractability, coverage, earned, accuracy, retrieval-blocked) and profiles the source mix per engine. | After each sampling run |  |
| `prompt-set-designer` | auto + notice | Builds persona-weighted, TOFU-to-BOFU discovery prompts, including branded and comparative ones. | Onboarding; weekly re-mine |  |
| `panel-steward` | approval | Proposes quarterly changes to the customer-owned reporting panel from the discovery panel, and protects the audit slice. | Two weeks before quarter end |  |
| `campaign-planner` | approval | Drafts the quarterly campaign plan (goals, targets, deadlines, owners) for human approval. | Quarterly; major signal |  |

**Content execution**

| Skill | Tier | What it does | Runs on | On this branch |
|---|---|---|---|---|
| `brief-strategist` | auto | Writes a v3 brief: evidence-driven format and structure, answer to beat, at least 1 first-party information-gain item, fan-out map, money page, doorway and BOFU guardrails. Lints itself before a human sees it. | Pipeline brief step |  |
| `claim-entailment-and-citability-qa` | auto | Checks that numbers and claims are entailed by their sources, checks n-gram originality, enforces manifesto bans, and simulates retrieval. | Every draft attempt |  |
| `sme-interviewer` | auto + notice | Asks experts 3–5 brief questions in Slack and turns answers into consented quote facts. | Brief approved |  |
| `section-writer-and-repair` | auto | Drafts by section, runs a voice editor pass, and regenerates only the failing sections. | Pipeline draft step (later phase) |  |
| `byod-intake` | auto + notice | Brings customer and agency drafts into the same QA, publish, measure and attribution loop. | Draft submitted |  |

**Lifecycle and published surface**

| Skill | Tier | What it does | Runs on | On this branch |
|---|---|---|---|---|
| `decay-triage` | approval | Classifies each page as protect, update stats, refresh, expand, consolidate, noindex or retire. | Nightly; a 'lost' verdict |  |
| `refresh-auto-revert` | auto + notice | Rolls a refreshed page back to its prior version automatically when clicks, position or citation presence fall beyond threshold against controls at +28 days. | +28 days after every refresh | Manual rollback only (item 4) |
| `schema-rematerializer` | auto + notice | Rebuilds head and JSON-LD for every published page with no LLM call. | Entity, canonical or author change |  |
| `internal-link-planner` | auto + notice | Plans hub-and-spoke and money-page links with varied anchors, plus back-links from existing pages. | Brief creation; publish |  |
| `indexing-notifier` | auto | Sends IndexNow pings for proxied URLs on publish, refresh and takedown, and tracks time to first crawl. | Publish, refresh, takedown |  |
| `site-integration-checker` | auto | Checks that the subfolder is integrated into the customer's site (nav and footer links, own chrome, real authors, in-category topics), and audits AI-crawler blocks and snippet directives. | Onboarding; weekly |  |
| `money-page-auditor` | approval | Finds main-site and docs fixes that answer BOFU prompts: pricing text, trust centre, integration directory, client-side-rendering issues. | Monthly; accuracy signal |  |
| `brand-accuracy-correction` | approval | Traces wrong claims to the cited third-party sources and opens on-site and off-site corrections. | Claim inaccurate in at least 30% of samples for 2 consecutive weeks |  |

**Earned media and authority**

| Skill | Tier | What it does | Runs on | On this branch |
|---|---|---|---|---|
| `earned-target-lister` | auto | Lists third-party URLs cited for commercial prompts where rivals appear and the brand doesn't, with pay-to-play flags. | Weekly |  |
| `offsite-gap-analyst` | auto | Turns targets into costed, EV-ranked off-site actions, including review-category fixes. | Weekly per topic and engine |  |
| `draft-offsite-asset` | approval | Drafts disclosed pitches, review asks, community replies, LinkedIn articles and PR pitches from verified public facts only, following link-scheme rules. | Approved off-site action |  |
| `verify-placement` | auto | Confirms a placement is live, compliant (sponsored or nofollow where paid) and mentions the brand, then re-samples the linked prompts. | Daily for placed actions |  |
| `authority-gap-diagnoser` | auto | Separates content gaps from authority gaps using referring domains and mention velocity. | Weekly |  |

**Governance and autonomy**

| Skill | Tier | What it does | Runs on | On this branch |
|---|---|---|---|---|
| `publish-safety-check` | auto | Enforces topical fit, velocity, originality, claims, and injection and leak scans before publish. | Pre-publish | Partly, item 8: topical floor, pace, leak and injection scan |
| `circuit-breaker` | auto | Pauses publishing or noindexes a site when index health collapses, spend spikes or failures cluster. Lowers autonomy levels. | Daily index-health job; event-driven | Manual switches only (item 4) |
| `risk-policy-evaluator` | auto | Deterministically assigns each action to tier 0–3 and decides auto, review window, ask or forbid. | Before every dispatch and publish |  |
| `approver-router` | auto | Routes each approval to the named approver for its risk class, with SLA reminders, delegation and out-of-office fallback, in Slack, email or a Docs/Notion round trip. | Every tier-1 and tier-2 decision |  |
| `autopilot-dispatcher` | auto + notice | Selects and starts work under cadence, budget, velocity, diversity and policy, after re-validating evidence. | Daily per site |  |
| `visibility-sentinel` | auto + notice | Confirms anomalies by re-sampling before raising signals. | Every sampling completion |  |
| `weekly-strategist-planner` | approval | Bounded LLM proposal planner. Runs in shadow mode first and is adopted only if it beats the dispatcher. | Weekly singleton; confirmed anomalies |  |
| `outcome-learner` | approval | Refits pooled priors and per-site adjustments, and proposes style-memory updates from reviewer notes. | Monthly; after readouts |  |

**Reporting and attribution**

| Skill | Tier | What it does | Runs on | On this branch |
|---|---|---|---|---|
| `baseline-report-builder` | auto + notice | Produces the week-1 baseline report and the 90-day plan draft for strategist review. | 7 days after onboarding |  |
| `sov-analyst` | auto | Explains movement in recommendation share by engine: which intents, rivals and sources drove it, with confidence labels. | Weekly rollup |  |
| `strategy-memo-writer` | auto + notice | Writes the weekly senior-strategist memo from deterministic data. | Weekly |  |
| `pipeline-attributor` | auto | Links AI visibility and AI-referral touches to CRM contacts, deals and revenue, with caveats. | Daily CRM sync |  |
| `experiment-designer-and-lift-analyst` | auto + notice | Randomises the order of the stepped-wedge waves, pre-registers metrics, and writes pooled DiD readouts with confidence labels. | At selection; monthly readouts |  |

## Missing integrations

> **Owner's decision for this round.** Engine sampling goes through
> OpenRouter only, using the existing `OPENROUTER_API_KEY`. The probes are
> labelled as API-grounded and never blended with Google AI Overview data
> from the SERP trackers or with Profound's third-party data. The analysis
> ranked UI-capture vendors (DataForSEO's AI Optimization API) and direct
> engine APIs higher. They are listed below as it ranked them, marked as not
> adopted. SerpApi's AI Mode engine is a SERP collector rather than an answer
> probe, so it needs its own owner decision under this rule.

**P0** (9)

| Integration | Why | Notes | Status |
|---|---|---|---|
| DataForSEO AI Optimization API (LLM Scraper, LLM Responses, LLM Mentions, AI Keyword Search Volume, AI Mode SERP) | Cheapest native route to ChatGPT UI capture, Perplexity, Gemini and AI Mode, plus competitor prompt discovery and AI demand volume. Removes the Profound dependency. Credentials are already wired up in lib/serp/dataforseo.ts. | HTTP Basic auth (existing). Vendor-page pricing, unverified live: LLM Mentions: $0.10/task + $0.001/row. LLM Scraper: from about $0.0012/result. AI keyword volume: $0.01/task + $0.0001/row. Route calls through cachedCall with a cache key of engine + sample_index + paraphrase_id, behind the atomic governor. UI-scrape output depends on consumer interfaces that can break and carries ToS risk, so keep an API-probe fallback and label the series separately. | Not adopted: engine sampling is OpenRouter only (owner's decision) |
| DataForSEO Labs (ranked_keywords, domain_intersection, SERP competitors, keyword difficulty) | Fastest route to the BOFU demand named rivals already win, and the input for the organic co-primary north star. Uses existing credentials. | Same login. Goes through the governor. Writes competitor-sourced measure.questions with volume and difficulty. Also covers EMEA/APAC once the location map is extended. | Partly, item 9: `ranked_keywords` only |
| SerpApi google_ai_mode engine | AI Mode cites a different URL set from AIO and has its own impressions line in GSC. It is the cheapest second engine, on a key that already exists. | engine=google_ai_mode at the standard per-search price. Store as surface ai_mode. Fix SERPAPI_KEY vs SERPAPI_API_KEY first. Use as the second collector alongside DataForSEO AI Mode. | Not started (the key-name mismatch is fixed, item 3) |
| Google Search Console API widening (site-wide query, query×page, searchAppearance, URL Inspection) | Needed for cannibalisation detection, site-wide demand, branded-search lift, indexed vs cited, and the index-health breaker. Also fixes the 16-month backfill restarting every day. | webmasters.readonly is enough for searchanalytics.query and URL Inspection (about 2k inspections/day/property; sample by cohort). Page through month-sized windows. Store query×page in a dedicated partitioned table, not jsonb rows. | Not started |
| GA4 Data API keyEvents + Admin API | 'conversions' is deprecated. The prefix filter hides AI traffic to pricing, docs and the homepage. The referrer table misses newer engines. | Request keyEvents. Remove the landingPage BEGINS_WITH filter. Make the referrer host table data-driven and add utm_source=chatgpt.com. Label AI-referral as a floor. Optionally create an 'AI assistants' channel group. | Not started |
| Anthropic SDK, direct path (structured outputs, prompt caching, effort, refusal fallbacks, web search/fetch) | Fixes the temperature 400s, replaces JSON-by-instruction, cuts cost and enables the research stage. OpenRouter does not carry these API-native features. | Use output_config.format and output_config.effort. Opus 5.5 defaults to medium effort; Opus 5 defaults to high. Sampling params return 400 on current models, and so does forced tool_choice any/tool on Opus 5.5 and Sonnet 5.5. Pricing: Opus 5.5: $4/$20, cache read $0.20. Sonnet 5.5: $2/$10, cache read $0.20. Haiku 5.5: $0.10/$0.50. Minimum cacheable prefix is 512 tokens on current models. Use server-side fallbacks:'default' for refusals (not on Batches; Haiku 5.5 has none). Web search is about $10 per 1k searches (verify) and is direct API only. Keep OpenRouter only as an outage fallback. | Not started; item 1 fixed the existing client |
| IndexNow | Free, quick discovery by Bing, Yandex, Seznam, Naver and Yep. Bing discovery feeds Copilot and part of ChatGPT retrieval. | POST api.indexnow.org/indexnow with {host, key, keyLocation, urlList}. A key file served under the proxy prefix can submit only prefix URLs. Webflow and other CMS hosts need the key at their root, which is a customer setup task, so v1 covers proxy URLs only. Log submissions to ops.index_submissions. | Not started |
| Cloudflare API, read-only (AI Crawl Control categories, Bot Fight Mode, pay-per-crawl) | Many B2B zones block OAI-SearchBot, ChatGPT-User or PerplexityBot at the edge before the proxy ever sees the request. Content work cannot fix this, so it belongs in onboarding. | Scoped read-only token, optional. Otherwise rely on per-UA probes of the live homepage, pricing and docs. Search/Agent/Training categories were split in July 2026 (per Cloudflare docs; re-verify). | Not started |
| SSO (SAML/OIDC) + SCIM provider | InfoSec blocks the PO without it. It also carries the new approver and legal-approver roles. | WorkOS-class provider or a native implementation. Map IdP groups to org roles. Audit-log every role change. | Not started |

**P1** (11)

| Integration | Why | Notes | Status |
|---|---|---|---|
| HubSpot (CRM, later CMS) | Pipeline and revenue attribution is the renewal metric, and it has been pulled into Phase 2. The same OAuth later enables HubSpot CMS publishing. | OAuth2 on a shared PKCE/refresh layer. CRM v3 objects and Associations v4. Burst limits of about 110–190 requests per 10 seconds (third-party figures; verify). Marketplace requires 429s below 5%. Reuse the Retry-After handling in lib/fetch/retry.ts. | Not started |
| Salesforce | Enterprise CRM pipeline attribution. | OAuth2 connected app. Join Opportunity and Lead objects on first- and last-touch landing pages, writing CRM surfaces. | Not started |
| Warehouse export (BigQuery / Snowflake / S3) | RevOps joins this data in Looker. Buyers rank it above an MCP server. | Daily partitioned export of visibility_weekly, answers (text + citations), content_outcomes and attribution. Service-account auth per customer. | Not started |
| Google Search Status Dashboard | Annotates attribution and stepped-wedge analyses with update windows, and freezes velocity ramps during rollouts. | Poll the public incidents feed into measure.platform_events. | Not started |
| DataForSEO Backlinks + Content Analysis | Mentions and referring domains are strong (correlational) predictors of AI visibility. Difficulty is a proxy today. | Existing credentials, through the governor. Unlinked mentions on publisher domains become link_reclaim actions. | Not started |
| Perplexity Search API / Sonar | Same retrieval stack as consumer Perplexity. Gives the retrieval rank of the customer's URL. | Search API about $5 per 1k requests (third-party figure; verify). Use for panel and diagnostic work. | Sonar is probed via OpenRouter (item 7); Search API unused |
| Gemini API grounding with Google Search | webSearchQueries is the closest public view of Google fan-out. Also a Gemini collector. | Gemini 3+: 5k free queries/month, then about $14 per 1k queries. One prompt can trigger several billable searches. Grounding chunk URIs are redirects and must be resolved. | A Gemini model is probed via OpenRouter (item 7); fan-out not captured |
| Docs and help-centre inventory (sitemaps; ReadMe, Mintlify, Zendesk Guide, Intercom Articles) | BOFU prompts ('does X support SSO') are answered from docs and help pages, which must be in the inventory and the refresh scope. | Crawl sitemaps first. Use vendor APIs only where sitemaps are missing. Content goes through redact.ts. | Not started |
| Bing Webmaster Tools AI Performance (CSV) + GSC generative-AI report (CSV) | The only first-party AI citation and impression data. Used as optional manual calibration, not a dependency. | No API as of 2026. Monthly CSV import into external_metrics. Keep a provider interface ready for when APIs ship. The GSC 'Search generative AI' setting cannot be read through any API, so the customer attests it. | Not started |
| WordPress REST API | The most common CMS for this ICP after Webflow. Enables native publishing and refresh. | /wp-json/wp/v2/posts with Application Passwords. Write drafts first. Inject JSON-LD through a plugin field or embed. | Not started |
| Status page + synthetic monitoring | The published SLO and incident comms are part of the enterprise trust pack. | Per-domain synthetic checks of /prefix/aeo-health and a sample article, backed by the existing health monitor. | Not started |

**P2** (9)

| Integration | Why | Notes | Status |
|---|---|---|---|
| Google Docs / Notion review round-trip | Reviewers won't live in the app, and approval latency is the throughput limit before autonomy. | Export the draft as a doc in suggestion mode. Import accepted suggestions as a human content_version and measure edit distance. | Not started |
| Task routing (Asana / Jira / Linear / Notion) | Off-site actions and main-site technical fixes need owners in the tools teams already use. | Create issues from money-page and off-site actions, with status sync back to actions. Start with Slack and CSV. | Not started |
| OpenAI Responses API web_search | Cheap ChatGPT-like retrieval probe for separating retrieval failures from selection failures. | About $10 per 1k calls plus content tokens. Label as api_probe; never blend with UI capture. | An OpenAI model with web search is probed via OpenRouter (item 7) |
| Customer-facing read API + MCP server | Competitors ship MCP. Customers' own agents should be able to query the platform. Ranked below the warehouse export. | Requires an org-scoped token layer, which does not exist today. Read-only. Writes only through propose/approve. | Not started |
| MCP OAuth 2.1 + read-only tool calling in the custom connector | Hosted Notion, Atlassian, HubSpot, Gong and G2 MCP servers use OAuth and expose tools, not resources. | PKCE plus dynamic client registration, tokens in Vault, an allowlist of search/fetch tools, all content through redact.ts. | Not started |
| Wikidata REST API (read-only) | Checks that the QID, official website (P856) and sameAs are consistent with the Organization @id. | Descriptive User-Agent; 2026 rate limits apply. Produce disclosed suggestions only, never edits. | Not started |
| G2 API / G2 MCP; Capterra/TrustRadius public pages | Review-grid category placement and review velocity determine 'best X software' eligibility. | Public profile checks first. The customer's own G2 token is optional and enterprise-gated. | Not started |
| Ahrefs Brand Radar / Semrush / Similarweb (bring your own key) | Authority diagnosis and competitor AI-referral traffic for customers who already pay for these tools. | Labelled as the vendor's numbers, never a dependency. Ahrefs v3 /brand-radar; Semrush via CSV or MCP. | Not started |
| Backlog: Framer, Contentful, Sanity adapters; Vercel/Netlify drains, Cloudflare Logpush; Web Bot Auth; YouTube Data API; Gong/Intercom/Zendesk; Microsoft Teams; Claude Managed Agents / AgentKit | Each competes with reporting, attribution and trust work and does not move renewals for most of the ICP yet. Revisit after Q2 2027. | Framer Server API is beta. The Contentful CMA rate limit is about 7–10 requests/sec. Netlify drains are Enterprise-only. Webflow-hosted sites have no logs. Use YouTube videos.list only. Managed Agents is not ZDR-eligible. | Not started |

## Autonomy design

Design only this round: no autonomy code ships. Deterministic code decides
what ships. A model writes memos, briefs, drafts and proposals.

| Level | Name | What runs without a click | Where we are |
|---|---|---|---|
| L0 | Manual tool | Nothing, and runs could not finish | At `cac7d6a` |
| L1 | Assisted operator | Humans start work, and the system finishes reliably, logs everything and can be switched off. Tier-0 changes run through the dispatcher. | Partly: runs finish (item 1), can be switched off (item 4) and are capped (item 5). Still needed: pipeline hardening, event consumers, the activity log and the dispatcher. |
| L2 | Refresh autopilot | Refreshes of owned, indexed pages with a "lost" verdict, with auto-revert | Phase 4b |
| L3 | Policy-bounded autopilot | Grounded new pages in opted-in topics, published noindex during a review window | Phase 4c, after a site's first 90 days or 20 pieces |

**Tiers**

| Tier | Covers | Decision |
|---|---|---|
| 0 | Changes visitors cannot see: schema, proxy internal links, IndexNow, sitemap and llms updates, re-materialisation | Automatic. The only tier that may auto-approve on timeout. |
| 1 | Refreshes of owned, indexed pages that add no new claims. Grounded new pages in approved topics, but only after the site's first 90 days or 20 pieces (whichever is later) and with the customer's opt-in per topic. | Auto-publish with a review window counted in business hours, and auto-revert at +28 days if the page underperforms its controls. New pages publish noindex during the window and become indexable when no one objects. |
| 2 | Pricing, security and compliance, competitor comparisons, YMYL, new fact types, judge disagreement | Always asks the named approver for that risk class, with an SLA, delegation and out-of-office fallback |
| 3 | Testimonials, invented quotes, customer names without permission | Forbidden |

The agent drafts off-site work and named humans carry it out. Any circuit
breaker lowers a site's autonomy level automatically, and raising it again
needs fresh evidence. Customers keep freeze windows, a notification on every
publish, and a kill switch throughout.

**Architecture**

1. **Sensors.**
   - The answer ledger (engine × intent × paraphrase × sample × method),
     read only through SQL views.
   - Native collectors, with health monitoring and failover.
   - GSC and GA4 through the API, plus URL Inspection.
   - Worker crawl telemetry and index-health cohorts.

   All of them emit typed events.
2. **Decision layer.** A sentinel that re-samples to confirm an anomaly
   before raising it. One EV scorer (hand-set priors in v0, pooled and
   calibrated in v2) over a deduplicated, intent-keyed queue with fresh
   evidence.
3. **Dispatcher.** A daily singleton per site that re-validates evidence
   before acting. It applies cadence, budget, velocity, diversity and
   stepped-wedge waves, then the policy pre-check. It dispatches with
   compare-and-set and logs every pick and skip.
4. **Policy engine.** Deterministic code: deny wins and errors fail closed.
   It writes immutable decisions with a pinned policy version and hands work
   to the approver router. It governs the platform's own publish tools, which
   vendor permission systems do not cover.
5. **Executors.**
   - The existing pipeline, refresh, publishing and off-site functions, plus
     QA v2, the safety governor and auto-revert.
   - Model calls on the direct path, streamed inside `step.run`, with a
     cached per-site prefix, structured outputs and refusal fallbacks.
   - OpenRouter kept only as an outage fallback for schema-validated JSON
     tasks.
6. **Strategist output.** A weekly memo and a quarterly campaign plan,
   written by a model over a typed, read-only tool surface. A proposal
   planner runs in shadow mode for one quarter, and is adopted per site only
   if evals show it beats dispatcher plus memo.
7. **Learning.** Outcomes and experiments feed pooled cross-tenant priors,
   with per-site shrinkage, which calibrate the win probability, value
   weights and autonomy thresholds.
8. **Oversight.**
   - A trace id across every step, and `actor='agent'` audit rows.
   - The activity timeline, the memo, the QBR and the answer explorer.
   - Kill switches at global, org and site level, wired through `cancelOn`
     and re-checked before every publish.
   - Prompts and policies version-pinned at run start.
   - Long horizons handled by cron ledger jobs, not long sleeps.
9. **Customer surface.** The read-only tools are exposed later as a customer
   API and MCP server, once the trust pack and org-scoped tokens exist.

Claude Managed Agents and Inngest AgentKit stay in the backlog: Managed
Agents is not eligible for zero data retention, and there is no evidence yet
that either beats one bounded loop.

**Guardrails**

- **Policy.** Tiers are evaluated in deterministic code; deny wins, and
  errors fail closed to "ask". Every publish has a policy decision with a
  rule id or a human approver, and a pinned policy version.
- **Timeouts and new pages.** Only tier 0 may auto-approve on timeout. New
  pages stay "ask" for at least 90 days or 20 pieces. After that they need a
  per-topic opt-in and publish noindex during a business-hours review window.
- **Earned autonomy.** About 20 consecutive approvals with low edit distance,
  zero QA overrides, a cohort index rate of at least 80%, and pass^3 on the
  safety evals. Any breaker reverts the site.
- **Approvers.** Named per risk class: product marketing for competitor
  claims, legal for pricing, security and compliance, brand for voice. Each
  has an SLA, delegation and out-of-office fallback.
- **Refresh auto-revert** at +28 days against controls.
- **Spend.** Atomic reserve-then-settle with org, site and article caps
  (shipped, item 5), and cost targets tied to plan price.
- **Velocity.** A floor of 2 per week for the first cohort (shipped, item
  8). It ramps by 1.5× only when the index rate is at least 80% and
  impressions per page clear the site median. Refreshes count toward it, and
  ramps freeze during Google update rollouts.
- **Index-health breaker.** If the 30-day index rate drops below 70%, or
  subfolder impressions fall more than 50% week over week while the rest of
  the site holds, publishing pauses until a human resumes it.
- **Kill switches** at global, org and site level (shipped, item 4).
- **Content truth.**
  - Every number matches its quote or fact.
  - Competitor sentences carry dated sources.
  - Testimonials and named customers need facts with publish permission.
  - No invented quotes and no synthetic personas.
- **Anti-scale and anti-doorway.**
  - One canonical URL per intent, decided by SERP overlap.
  - Per-format substance rules and caps on variants.
  - A SERP-distinctness test before minting a URL.
  - Cross-tenant originality checks.
  - Self-promotional listicles at 20% or less.
  - Page structure chosen from evidence, not a fixed skeleton.
- **Structured-data policy.** No ratings markup about the customer's own
  product, no HowTo, and FAQPage only for a visible, evidenced FAQ. Pages
  render in the customer's theme, and templates are never varied to hide the
  vendor.
- **Injection and leak defence.**
  - Generation sees only verified public facts.
  - Untrusted text is passed as quoted data, with no tools.
  - A pre-publish scan (shipped, item 8).
  - Read-only planner tools.
  - `safeFetch` everywhere.
- **Same content for every user agent**, enforced by a CI test.
  `dateModified` changes only on a material diff.
- **Off-site work is done by humans**, with sponsored or nofollow links and
  disclosure on paid placements.
- **Measurement honesty.**
  - Frozen, customer-owned panels with an audit slice.
  - Intervals at cluster level only.
  - Lift labelled leading, likely or proven.
  - Series from different methods never blended.
  - Methodology versioned, with restatements (shipped, items 3 and 7).
- **Separation of roles.** No generating call approves its own output.
  Judges use a separate context and a different model.
- **Editorial responsibility.** A record on every version, and an
  AI-disclosure option for EU tenants under Art. 50(4).

**Blockers to autonomy, and where they stand**

| Blocker at `cac7d6a` | Now |
|---|---|
| The human gate never resolved | Removed (item 1) |
| Temperature sent to Claude 5 models; audit caps would truncate | Removed (item 1) |
| No takedown, noindex, 410, rollback or kill switch | Removed (item 4) |
| The Worker forced cache TTLs and had no version | Removed for sites that redeploy Worker v2 (item 2) |
| Nothing auto-starts; `remainingCadence` has no callers | Remains (`autopilot-dispatcher`) |
| A single approval-policy enum with no writer; Slack approvals not authorisation-checked | Slack decisions are org-checked (items 1, 2); the policy model remains (`risk-policy-engine`) |
| The reward signal is wrong | Per-asset metrics and native-only reads fixed (item 3); the outcome ledger remains (`truthful-outcome-ledger`) |
| No LLM budget, atomic SERP budget or article cap; entitlements unenforced | Budgets and caps shipped for pipeline model, SERP and probe calls (item 5); audit model calls, embeddings and entitlements remain |
| Five producers scored on incompatible scales | Removed (item 8) |
| No coverage check | Removed (item 8); intent clusters remain |
| No index-health or manual-action awareness | Remains (`gsc-ga4-widening`, `publish-safety-governor`) |
| Eleven events without consumers; no `onFailure` or `cancelOn` | Remains (`event-consumers-observability`, `pipeline-hardening`) |
| No eval harness | Remains (`eval-harness`) |
| The prompt-injection trifecta: private data, untrusted web text and a public publish channel | QA uses `safeFetch` (item 1) and a pre-publish scan (item 8); generation hygiene remains |
| No trust pack, customer-owned panel or activity log | Remains |

**Steps**

| Step | When | Scope | Exit | Status |
|---|---|---|---|---|
| 0 | Week 0 | `pipeline-hotfix` | At least 10 pages shipped end to end | Shipped (item 1); the page count needs design partners |
| 1 | Phase 1, by 2026-12-11 | Durable, safe executor and truthful sensors. The trust pack starts. | L1: humans click, and the system finishes, logs and can be switched off | Most shipped this round; see [What comes next](#what-comes-next) |
| 2 | Phase 2, by 2027-02-26 | Frozen panels, native sampling, baseline, QBR, organic gap, earned targets, accuracy judge, HubSpot, runtime and eval core | At least 3 partners use the QBR | Partly (items 7, 8, 9) |
| 3 | Phase 3, by 2027-06-04 | Make the work worth automating and provably safe | Pooled lift with a CI; the breaker trips within 48 hours in simulation | Not started |
| 4 | Phase 4a, from 2027-04-19 | Risk-policy engine; tier 0 on through the dispatcher at L1 | No publish without a policy decision | Not started |
| 5 | Phase 4b | L2 refresh autopilot per site; decision layer and memo | At least 70% of actions click-free; 0 dispatches on closed gaps; rejections below 5% | Not started |
| 6 | Phase 4c | L3 per opted-in topic, noindex review windows | Cohort index rate of at least 80%; positive pooled lift | Not started |
| 7 | Phase 4d, Q3 2027 | Outcome learning; planner in shadow mode; customer API and MCP | Planner adopted only where it wins | Not started |

## Competitive edge

Vendor facts here are as reported in secondary sources and are unverified.

| Versus | Where we differ |
|---|---|
| Profound (reported Series D, plus Aim and Agents) | We publish on the customer's own domain through a zero-JS proxy, with an off switch and an exit plan, so there is no CMS project. The customer owns a frozen panel with an audit slice, so we don't grade our own homework. Lift comes from pooled stepped-wedge comparisons, not pre/post charts. Native engines in mid-market tiers. Autonomy governed by policy, with named approvers. |
| Webflow AEO | Any CMS, through the proxy and then WordPress and HubSpot CMS. Cross-engine SERP and answer measurement. Money-page and off-site workstreams. Grounding in the brand brain, and attribution to pipeline. |
| Scrunch AXP (Sitecore), Adobe LLM Optimizer at the edge | Both need a CDN team and a DXP. We serve identical content to every user agent and prove it in CI, and our `.md` twins carry a canonical. That is a compliance advantage over bot-only rewriting, which sits close to cloaking. |
| BrightEdge, Conductor | Self-serve onboarding, a week-1 baseline and a warehouse export, for companies of 200–1,000 people. |
| AthenaHQ, Peec, Otterly, HubSpot AEO (trackers, about $29–$495) | They track and recommend. We do the work end to end and prove the lift, and we run the off-site program they only suggest, with costs, link-scheme rules and named owners. |
| AirOps, Promptwatch (content engines) | Drafts gated on claim truth, passage citability, first-party information gain and one URL per intent: the quality bars that keep scaled AI content from being demoted. |
| Relixir, Writesonic (high-volume auto-publish) | Velocity capped against the cohort index rate, coverage and doorway guards, an index-health breaker and refresh auto-revert: autonomy that cannot get the customer penalised. |
| Daydream and AI-native agencies | A week-1 baseline, a quarterly plan, a weekly memo and a QBR, at software margins. Bring-your-own-draft makes us the system of record next to an agency. |
| Ahrefs Brand Radar, Semrush | They have the biggest indexes but stop at insight. We add organic gaps, a per-engine source-role map, accuracy correction and causal attribution per asset, and can ingest their data on the customer's own key. |
| Evertune, Similarweb | We match their statistical honesty with paraphrase sampling and cluster-level paired intervals, and tie every movement to an action that shipped and a not-yet-treated control. |
| Enterprise trust as a feature | SSO and SCIM, SOC 2, a DPA, a published SLO and a full export with a redirect map. This answers "what happens to my pages if I churn?" before Legal asks. |
| Accuracy as the lead message | "What ChatGPT says about your pricing, SOC 2 and integrations, and how we fix it at the source." The fastest route from a VP of Marketing's anxiety to visible value. |

## Market and research digest

**Method and caveats.** Six research tracks ran on 2026-10-16. Web search
worked, but vendor and study pages could not be opened (egress and DNS
failures), so every figure below comes from search-result extracts of vendor
pages, press releases and third-party reviews. The search budget also ran out
part-way through some tracks. Vendor claims are claims. **Every number in this
section is unverified.**

### The market

- **The category moved from monitoring to agents that do the work.**
  Profound is reported to have raised a Series C at a $1B valuation (February
  2026) and a Series D at $1.8B (September 2026). It ships Agents, a workflow
  builder with CMS nodes and optional auto-publish, and Aim, a background agent
  that turns signals into approved projects. Measure-write-publish on its own
  is no longer unique.
- **Suites are absorbing the category,** as reported:
  - Adobe completed its Semrush acquisition (April 2026).
  - Sitecore bought Scrunch (June 2026).
  - HubSpot bought XFunnel and sells HubSpot AEO at about $50 a month.
  - Webflow launched Webflow AEO for enterprise (May 2026).

  Mid-market B2B SaaS on Webflow, WordPress or headless stacks is not buying
  AEM or Sitecore, so a CMS-agnostic AEO layer is still open.
- **Edge-served agent experiences became an enterprise category:** Scrunch
  AXP, Adobe Optimize at Edge, BrightEdge Agent Edge, and Cloudflare Markdown
  for Agents. Google's John Mueller has criticised serving bots alternate
  pages chosen by user agent.
- **Monitoring is cheap and metered.** Entry prices are reported from about
  $29 to $399 a month, and enterprise tiers start around $2k. Common buyer
  complaints are "tracks but doesn't tell me what to fix", per-prompt and
  per-engine metering, and content that needs heavy editing.
- **Pressure from below.** AI-native agencies such as Daydream (reported $15M
  Series A) and auto-publishers such as Relixir and Promptwatch.
- **Table stakes in October 2026:**
  - Multi-engine tracking.
  - Mentions, citations and share of voice.
  - Prompt sets with volume estimates.
  - Citation-source reports.
  - Crawler analytics.
  - A readiness audit.
  - GSC and GA4 integration.
  - An action center.
  - Export, API or MCP.
  - Agency plans.
- **The white space** no single vendor combines for mid-market B2B SaaS:
  - First-party publishing with no CMS project.
  - Provenance-grounded drafts at a mid-market price.
  - A closed loop proven with causal statistics.
  - Owned plus earned media in one plan.
  - Safe autonomy.
  - A refresh engine for already-cited pages.

| Vendor | Positioning (as reported) | Executes work? |
|---|---|---|
| Profound | Enterprise leader, repositioned in 2026 as an AI platform for marketing teams with agents; answers captured from engine front ends | Yes |
| AthenaHQ | Tracking plus an Action Center with briefs and outreach suggestions | No |
| Scrunch (Sitecore) | Monitoring plus AXP, which routes agents at the CDN to a stripped version of the site | Partly |
| Peec AI | Well-liked mid-market monitor with unlimited seats and an MCP server | No |
| Otterly.ai | Low-cost monitoring from $29, with an API | No |
| Goodie AI | Closed-loop platform with a content writer | Yes |
| Bluefish | Fortune 500 agentic marketing | No |
| Evertune | Statistical brand index across 11 engines, plus a content studio | Yes |
| Daydream | AI-native SEO/AEO agency (agents plus human experts) | Yes |
| AirOps | Content engineering workflows; Page360 joins citations, GSC and GA4 | Yes |
| Relixir | Auto-publishes 10+ blogs a week for B2B | Yes |
| Writesonic GEO | Visibility tracking plus an article agent, WordPress publishing | Yes |
| Semrush (Adobe) | AI visibility inside the largest SEO suite | No |
| Adobe LLM Optimizer | Edge optimisation for agent traffic, tied to AEM | Yes |
| Ahrefs Brand Radar | Largest prompt index, metered custom tracking | No |
| Conductor | Enterprise AEO with an MCP server and an OEM deal with Acquia | Yes |
| BrightEdge | Enterprise suite with AI Catalyst and Agent Edge | Yes |
| seoClarity | ArcAI insights, accuracy and actions | Yes |
| Similarweb | Panel-based AI referral traffic for any site, competitors included | No |
| HubSpot AEO | Grader and a low-cost tracker built into the CRM | No |
| Webflow AEO | Analytics and agents inside the Webflow CMS | Yes |
| Promptwatch | Tracking plus content agents publishing to WordPress and Webflow | Yes |
| Brandlight | Enterprise visibility for CMOs | No |
| geoSurge | Aims to influence the model and training layer | No |

### How engines choose sources

- **Google is documented.** AI Overviews and AI Mode need a page that is
  indexed and eligible for a snippet, with no extra technical requirements.
  Both use query fan-out. Search Console added generative-AI impression
  reports in June 2026, with no click data and no API.
- **Organic rank and AI citation are drifting apart.** One Ahrefs study found
  only 38% of AI Overview-cited pages rank in the top 10 for the same query,
  down from 76% a year earlier. Fan-out is the reported cause.
- **AI Mode and AI Overviews behave like two engines,** with about 14% overlap
  in cited URLs reported.
- **ChatGPT.** OAI-SearchBot controls inclusion in ChatGPT search, and
  ChatGPT-User makes user-initiated fetches. Retrieval is not citation: one
  study found ChatGPT cited 15% of the pages it retrieved.
- **The other engines.** Perplexity runs its own index with freshness as a
  stated priority. Claude's web search is likely Brave-backed, though this is
  not officially stated. Microsoft judges content section by section.
- **Third parties dominate commercial answers.** Earned and editorial media,
  listicles, Reddit, YouTube and LinkedIn appear heavily, with large
  differences between engines. Self-ranked "best X" listicles get cited but
  often lead to a competitor being recommended.
- **The levers with evidence behind them:**
  - Server-rendered HTML; the major AI crawlers do not run JavaScript.
  - Substantive freshness.
  - Answer-first passages (most citations come from the first 30% of a
    page).
  - Original data.
  - Third-party mentions (correlational only).
- **The levers without:**
  - llms.txt: controlled studies show no effect, and bots rarely request it.
  - JSON-LD for citation lift: a matched study showed none.
  - Markdown or bot-only pages: Google has criticised them as close to
    cloaking.
- **Answers are volatile.** Repeat runs rarely return the same brand list, and
  presence is far more stable than position. That is why reporting uses
  presence rates with intervals, never a single rank.

### What a senior B2B SaaS program does

- Plans by cluster, not question, with one URL per intent, and models fan-out
  explicitly.
- Covers the full funnel with formats engines cite: alternatives, X vs Y,
  pricing, integrations, use cases, glossaries and benchmarks. Each format
  needs a guardrail against doorway patterns.
- Requires information gain: first-party facts, sourced statistics and named
  expert quotes.
- Treats E-E-A-T as data: real authors and reviewers, and a consistent
  Organization entity with `sameAs`.
- Runs an off-site program: review sites, communities, LinkedIn, video and
  digital PR, all disclosed and never astroturfed.
- Refreshes on evidence, weighted by engine.
- Proves lift with matched controls, and reports a KPI tree from visibility to
  pipeline.

### Integrations and costs

All prices are from vendor or third-party pages, unverified:

- DataForSEO's AI Optimization API: per-task and per-row pricing for answer
  capture, mentions and AI keyword volume.
- SerpApi: AI Overview and AI Mode at its standard per-search price.
- OpenAI's web search tool: about $10 per 1,000 calls plus tokens.
- Perplexity Sonar: per-token pricing plus a per-request fee by context size.
- Gemini grounding: 5,000 free queries a month, then about $14 per 1,000.
- Anthropic web search: about $10 per 1,000 searches.
- Brave Search: about $5 per 1,000 requests.

Other platform notes:

- IndexNow reaches Bing, Yandex, Seznam, Naver and Yep, but not Google.
- Bing's AI Performance report and Search Console's generative-AI report are
  UI or CSV only.
- Reddit's Data API excludes commercial use.
- YouTube quota cannot be bought.
- Salesforce has agreed to acquire Contentful.

### Autonomous-agent practice

- Separate workflows (predefined code paths) from agents, and choose the
  simplest thing that works.
- Rules-based checks beat model self-critique. Judges need a separate context
  and a different model.
- Use policy-tiered approvals (always allow, always ask, auto), and record
  every decision.
- Enforce hard spend caps between model requests.
- Seed evals with 20–50 cases from real failures. Keep capability and
  regression suites separate.
- Long-running agents need structured state outside the context window,
  checkpoints, tracing and gradual deploys.
- Documented failure modes of autonomous business agents:
  - Selling below cost and being talked into discounts.
  - Hallucinated accounts.
  - Identity confusion.
  - Announced but unkept fixes.
- Inngest specifics:
  - `waitForEvent` expressions use `async` for the awaited event; this was
    the gate bug fixed in item 1.
  - `throttle` queues runs, while `rateLimit` drops them.
  - `concurrency` limits executing steps.
  - `singleton` allows one active run per key.

### Spam-policy and legal risk

- **Google's 2024 spam policies.** Scaled content abuse is judged "no matter
  how it's created". Site reputation abuse applies to third-party content
  even with first-party oversight, per Google's November 2024
  clarification.
- **What makes proxied subfolder content look like parasite SEO:**
  - Topics unrelated to the host's business.
  - A separate operation with its own templates and authors.
  - Little editorial control by the host.
  - No integration with the rest of the site.
- **Google's position on AI content.** It is acceptable when it is helpful.
  Quality raters give the lowest rating to low-effort AI content. Cloaking
  covers AI features too. Dates must not be refreshed without substantive
  change.
- **Signals and remedies.** Sudden page-count spikes come with indexing
  suppression, and the 30-day cohort index rate is the early warning. Manual
  actions appear only in Search Console.
- **Legal.** The EU AI Act's Art. 50(4) applies from 2026-08-02 to AI text on
  matters of public interest, unless it has had human editorial review. The
  FTC's fake-review rule (16 CFR 465) bans AI-generated reviews and
  testimonials.
- **The repository's starting point.** Strengths: `approve_both` by default,
  auto-publish opt-in, hard sourced-statistics gates, and a renderer that is
  identical for every user agent.

## Subsystem map

The code at `cac7d6a`, as the analysis mapped it, with the seam each
extension uses.

| Subsystem | What it was | Extension seam (and what used it this round) |
|---|---|---|
| Measurement and visibility (`lib/serp`, `lib/demand`, `lib/analytics`, attribution, Google and Profound connectors) | A two-vendor SERP client (DataForSEO for bulk work, SerpApi for AI Overviews) behind a day cache and a budget guard. A question graph from autocomplete and PAA, deduped and clustered by embedding. Tracked questions snapshotted on daily, weekly and monthly crons. | An answer-engine provider beside the SERP provider, through `cachedCall` (item 7: `lib/answers`) |
| Strategy and opportunities (`lib/strategy`, `lib/pipeline/opportunities.ts`, `lib/refresh`) | Four producers writing `content.opportunities` on (site, dedupe key): the nightly gap scan, signals, the refresh scan, and manual plus post-publish work. Scored with a fixed linear blend. | The score breakdown as an EV model (item 8: `scoreEV0`) |
| Content generation and QA (`lib/pipeline`, `lib/context`) | One durable function: brief → gate → item → draft and QA (3 attempts × 2 review rounds) → gate → publish → re-measure at 14, 30 and 60 days. Hybrid retrieval of chunks, facts and the manifesto. | The task router and JSON runner (item 1: per-task budgets and effort) |
| Published surface (`middleware.ts`, `app/(render)`, `lib/render`, `edge/`) | The customer routes a prefix to an edge hostname. Middleware resolves the host, guards loops and the prefix, decides indexability, strips cookies, and rewrites to `/render/<siteId>/…`. One route handler serves articles, `.md` twins and listings. | Header and status choke points (items 2, 4) |
| Audit and rule engine (`lib/audit`, `lib/aeo/rules`) | A public lead-magnet audit (rate-limited, 24-hour cache) that samples pages and runs six modules: crawler access, technical, schema, llms.txt, E-E-A-T and citability. | Site and page rule registries (next: `audit-correctness-fixes`) |
| Orchestration (`lib/inngest`) | 32 functions and 12 fixed-time crons at `cac7d6a`, with short automatic chains and one durable pipeline. | The typed event catalogue (items 1–9 added events and functions under `concurrencyCap`) |
| Integrations (`lib/connectors`) | One `Connector` interface with six providers (Google, Slack, Profound, Webflow, website, custom API/MCP). Vault tokens, `withSyncRun`, and paged sync. | Paged sync and the run marker (item 3: the Profound sweep) |
| Product surface and data model (`app/(app)`, `lib/app`) | A server-rendered shell driven by one nav table, with read models in `lib/app` and explicit scoping. An operator's console with no charts. | Cards per read model (items 3, 6, 7, 9) |

## Risks

| Risk | Mitigation |
|---|---|
| Delivery capacity: about 190 engineer-weeks committed | A dated cut line (GA by 2027-03-31), a backlog, and phase exits gated on design-partner outcomes rather than volume shipped |
| Live-domain exposure once pages ship | Takedown, the safety kit and Worker v2 (shipped, items 2, 4 and 8). The onboarding gate before the first publish. Managed cadence only after a cohort index rate of at least 80%. |
| Worker rollout: customers paste the Worker, so fixes reach Mode A sites only when they redeploy | Version telemetry and the outdated-install banner (item 2), origin-side defences, and later an optional scoped deploy token |
| Trust damage from restated numbers | A versioned methodology and an in-app restatement note with old and new values (item 3). The email note is still to come. |
| Measurement cost: paraphrases × engines × samples | Plan-tiered depth, the atomic governor (item 5), a cost target of at most 20% of price, and simple value tiers before Neyman allocation |
| Vendor and ToS risk on UI capture | Not taken this round: probes are API-based through OpenRouter (item 7). Any future UI capture needs two collectors, health monitoring and separately labelled series. |
| Scaled-content and site-reputation exposure grows with throughput; one manual action hurts every customer | Coverage guard, topical floor and pace (item 8), then doorway guardrails, the integration gate, customer theme and bylines, cross-tenant originality and the index-health breaker |
| Learning from noise: answers vary on every rerun, models get swapped, core updates confound results | Cluster-level paired intervals, stepped-wedge controls, pooled priors, platform-event annotations, an honest "inconclusive", and never selling fixed uplift |
| Empty but honest reports | Pooled lift, confidence labels, the evidence ladder, the answer explorer and pipeline attribution |
| Prompt injection (private data, untrusted web text, a public publish channel) | `safeFetch` in QA (item 1) and the pre-publish scan (item 8); generation hygiene and read-only planner tools still to come |
| Model-runtime drift: defaults, rejected parameters, refusals on security topics | Explicit effort and refusal handling (item 1); golden-set gates before changing defaults (`eval-harness`) |
| Off-site compliance: FTC rules, paid links, Reddit and Wikipedia norms | A deny-wins policy module, disclosure, and execution by named humans |
| Unverified evidence | Source every statistic before it reaches copy, and tune house heuristics (velocity 2–5 a week, similarity thresholds, index-rate breakers) on partner data |
| Inngest durability: long sleeps and replay against changed code | Cron ledger jobs, version pinning, never renaming steps while runs are in flight (the hold steps in item 4 keep their original ids) |
| Legal liability for published copy, and EU AI Act Art. 50 | An editorial-responsibility record, a named accountable editor, an AI-disclosure option, and legal approvers for tier-2 claims |
| Competitive convergence, and CMS vendors closing publishing paths | Customer-owned measurement, causal proof, safe autonomy, earned and money-page work, a CMS-agnostic proxy, and WordPress and HubSpot adapters |
| Commercial packaging: copy promising unbuilt features | Managed copy aligned (item 8); the monthly audit and closed-loop claims remain until `audit-v2-monitored` and attribution ship |

## This round

Ten commits on `claude/charming-ramanujan-kdmnd6`, in order, one pull
request. Each passes `npm run check` on its own, and every migration applies
in order to a fresh database with `supabase/tests/isolation.sql` and
`tests/db` passing.

| Item | Commit | Initiative |
|---|---|---|
| 1 | Approvals resume, Claude 5.x calls succeed, published pages match QA | `pipeline-hotfix` |
| 2 | Forged internal headers refused, Worker v2, IPv6 SSRF closed, webhooks re-drive | `security-hardening` (core) |
| 3 | AI Overview numbers native only, assets get their traffic, restatements explain moves | `measurement-integrity` |
| 4 | Pages noindex or retire in one click, kill switches pause sites, rollback needs no model | `takedown-kill-switch` |
| 5 | Pipeline model, SERP and probe calls hold their budget first, alerts fire once, articles stop at their cap | `spend-governor` |
| 6 | Competitors are the rivals you name; Reddit, G2 and Wikipedia shape answers instead | `source-role-ledger` |
| 7 | Every answer labelled by engine and method; AI engines sampled through OpenRouter, never blended | `answer-ledger-schema`, `native-multi-engine-sampling` (partly) |
| 8 | Queue ranked on expected value; covered questions become refreshes, pace capped, risky drafts reviewed | `unified-scorer-v0`, `publish-safety-kit` |
| 9 | Keywords rivals rank for and you don't: DataForSEO Labs gap, monthly, onto the queue | `competitor-organic-gap` (partly) |
| 10 | This roadmap, `docs/MEASUREMENT.md`, doc updates and the cloud-session startup hook | — |

**Migrations.** Each new table follows the pattern of 0012, 0015 and 0017:
row-level security enabled and forced, `tenant_read` on a denormalised
`org_id` kept by a trigger, and an explicit revoke from the renderer. Each
has a matching section in `supabase/tests/isolation.sql`. Enum `ADD VALUE`
statements sit alone in their own files.

| Migration | Item | Adds |
|---|---|---|
| `0018_security_hardening` | 2 | Webhook ledger `attempts`, `claimed_at` and `last_error`. `app.sites.worker_version` and `worker_seen_at`. A trigger refusing a connection bound to another org's site. |
| `0019_measurement_integrity` | 3 | Mining batch key and measure-error columns on questions. A cluster run marker. `app.metric_restatements`. |
| `0020_takedown_kill_switch` | 4 | `published_pages.status`, `version_id` and `previous_version_id`. `indexing_paused` on sites and `site_render_config`. `ops.autonomy_controls`, with a security-definer sync. |
| `0021_spend_governor` | 5 | `ops.budgets`, `ops.spend_counters` and `ops.spend_reservations`. Run, opportunity, cache-token and stop-reason columns on `ops.llm_calls`. |
| `0022_source_roles` | 6 | `context.entities.domains`. `measure.source_domains` (259 seeded domains). `measure.site_source_overrides`. `source_role` on citations, with a classifier function and backfill. |
| `0023_answer_ledger_enums` | 7 | Enum values only: the `llm_answer` and `ai_mode` surfaces and the `openrouter` provider |
| `0024_answer_ledger` | 7 | `measure.collection_method`. Engine, method, sample, paraphrase, run, answer and observability columns on snapshots. `measure.answer_mentions`. The `v_native_aio` and `v_answer_observations` views. The Profound backfill. |
| `0025_opportunity_scoring` | 8 | `content.action_type` and `content.dismiss_reason`. `search_volume`, `keyword_difficulty` and `search_intent` on questions. |
| `0026_competitor_gap_enum` | 9 | Enum value only: opportunity source `competitor` |
| `0027_competitor_gap` | 9 | `measure.competitor_keywords` |

**New environment variables** (all optional, documented in `.env.example`):

| Variable | Item | Purpose |
|---|---|---|
| `AEO_OPENROUTER_REASONING` | 1 | `1` forwards each task's effort to OpenRouter as `reasoning.effort`. Off by default. |
| `AEO_ANTHROPIC_FALLBACKS` | 1 | `0` turns off server-side refusal fallbacks on the direct Anthropic path |
| `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD` | 3 | Now listed. Both are required for DataForSEO. |
| `DATAFORSEO_SERP_COST_USD`, `DATAFORSEO_AUTOCOMPLETE_COST_USD`, `SERPAPI_SEARCH_COST_USD` | 3 | Budget estimates when a response carries no cost |
| `SERPAPI_API_KEY` | 3 | The SerpApi key. `SERPAPI_KEY` is still read, with a warning. |
| `AEO_SERP_AIO_PROVIDER` | 3 | `serpapi` (the default) or `dataforseo` for AI Overview questions |
| `AEO_DEFAULT_LLM_MONTHLY_BUDGET_USD`, `AEO_DEFAULT_ANSWER_PROBE_MONTHLY_BUDGET_USD` | 5 | Default org budgets ($200 and $25) |
| `AEO_ARTICLE_COST_CAP_USD` | 5 | Model spend per article across all its attempts ($15) |
| `AEO_SPEND_GOVERNOR` | 5 | `off` admits every call. For incidents only. |
| `AEO_ANSWER_ENGINES`, `AEO_ANSWER_ENGINES_ENABLED` | 7 | Per-engine JSON overrides, and which engines run |
| `AEO_ANSWER_PANEL_SIZE`, `AEO_ANSWER_SAMPLES` | 7 | Prompts per site (25, at most 100) and probes per prompt and engine (1, at most 3) |
| `AEO_PUBLISH_VELOCITY_MAX` | 8 | Ceiling on the weekly publishing pace (5) |
| `DATAFORSEO_LABS_COST_USD` | 9 | What each Labs call holds on the SERP budget ($0.12) |

**Deliberately not in this round:**

- Autonomy code (Phase 4).
- The model-runtime SDK move and streaming.
- GSC/GA4 widening and URL Inspection.
- Intent clusters and brief v3.
- HubSpot.
- The enterprise trust pack.
- Slack identity mapping.

**Cloud sessions.** `.claude/settings.json` registers a `SessionStart` hook
(matcher `startup`) that runs `scripts/session-start.sh`. The script does
nothing outside Claude Code cloud sessions (`CLAUDE_CODE_REMOTE=true`), and
skips the install when `node_modules` was built from the current
`package-lock.json` (a stamp holds the lockfile's hash). Otherwise it runs
`npm ci --no-audit --no-fund`, so `npm run check` works from a session's
first command.

## What comes next

The rest of the first tranche, in the analysis's order:

1. `pipeline-hardening`: terminal states, `cancelOn`, idempotent steps,
   honest bylines.
2. `truthful-outcome-ledger`: the per-asset reward signal.
3. `gsc-ga4-widening`: query×page, URL Inspection, key events, a paged
   backfill.
4. `event-consumers-observability`: consumers, heartbeats, the agent
   activity log.
5. `onboarding-readiness-gate`: crawler blocks, snippet directives, the site
   integration gate.
6. `audit-correctness-fixes`.
7. `enterprise-trust-pack`, in parallel.

Decisions and checks waiting on the owner:

- **AI Mode.** SerpApi's AI Mode engine is a SERP collector, not an answer
  probe. Is it in scope under the OpenRouter-only rule?
- **The Phase 2 exit** assumes ChatGPT UI capture. Restate it for API probes,
  or revisit UI capture.
- **Mode A customers** must redeploy the Worker to get v2's edge
  protections. Who contacts them?
- **OpenRouter model slugs and response shapes** for the four default engines
  were tested only against fakes. Confirm them with `GET /api/v1/models` after
  deploy.
- **The approval-resume integration test** needs the Inngest dev server in
  CI.
