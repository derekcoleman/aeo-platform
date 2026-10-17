# Measurement

Where each visibility number comes from, how it is labelled, what it is
never added to, and what happens when the way it is computed changes. If a
page shows a number, this file should explain it. The plan for what comes
next (frozen panels, paraphrases, cluster-level statistics, causal lift) is
in `docs/ROADMAP.md`.

## Sources, and how each is labelled

Every observation of a search or AI answer is a row in
`measure.serp_snapshots`, labelled with how it was observed
(`collection_method`), by whom (`provider`) and from which engine (`engine`).
Its citations are rows in `measure.serp_citations`, each on a surface
(`ai_overview`, `ai_mode`, `llm_answer`, `featured_snippet`, `organic`, …)
and, since migration 0022, with a source role (`owned`, `competitor`,
`ugc_forum`, `review_platform`, …; `lib/measure/source-roles.ts`).

| Source | `collection_method` | `provider` | `engine` | Read through | Shown on |
|---|---|---|---|---|---|
| Our SERP trackers: Google AI Overviews, featured snippets, organic results, People Also Ask | `serp` | `dataforseo`, `serpapi` | `google` | `measure.v_native_aio` | Demand, Strategy, Refresh, Attribution, the queue's scores |
| Our answer probes: each engine's model asked through its API, web search on | `api_probe` | `openrouter` | `chatgpt`, `perplexity`, `gemini`, `claude` (configurable) | `measure.v_answer_observations`, `api_probe` only | Strategy → Visibility → *Engines* |
| Profound (optional enrichment) | `third_party` | `profound` | Profound's engine (`google_aio`, `ai_mode`, `chatgpt`, `gemini`, …) | `measure.v_answer_observations`, `third_party` only | Strategy → Visibility → *Profound*, labelled as Profound's |

Search Console and GA4 are first-party metrics in `measure.external_metrics`,
not snapshots. The competitor organic gap is DataForSEO Labs ranking data in
`measure.competitor_keywords`, labelled as organic rankings. `ui_scrape` and
`first_party` are reserved method values that nothing writes yet.

The labels are enforced in the database, not only by the writers. A trigger
labels every Profound row `third_party` and every OpenRouter row `api_probe`.
A check constraint (`serp_snapshots_collection_check`, migration 0024)
refuses any row whose provider and method disagree: only DataForSEO and
SerpApi rows can be `serp`. Profound rows put their citations on the engine's
own surface (`measure.answer_surface()`): an AI Overview stays
`ai_overview`, AI Mode becomes `ai_mode`, and every other engine becomes
`llm_answer`.

## Never blended

Each source answers a different question, so no number adds two of them
together.

- **Native AI Overview numbers** (citation gaps, cited counts, snapshot
  counts, competitor citations, the queue's gap scores) read only
  `measure.v_native_aio`: rows from our own SERP trackers.
  `NATIVE_PROVIDERS` in `lib/demand/store.ts` names the same two providers,
  and `tests/answers-engines.test.ts` fails if the view and the constant
  drift apart. A Profound row or a probe can never decide whether a page is
  cited in an AI Overview.
- **Probe numbers** read `measure.v_answer_observations` filtered to
  `api_probe`, per engine. They are never added to the AI Overview numbers,
  to each other or to Profound's.
- **Profound numbers** read the same view filtered to `third_party`, on
  their own card.
- **Organic gap numbers** are rankings, not citations, and appear only on
  the competitor gap card and in the queue as opportunities.

Both views are `security_invoker`, so a member reading through them sees only
their own organisation's rows. The renderer role cannot read either
(`supabase/tests/isolation.sql`). Both views keep rows served from the cache:
the SERP and answer caches are shared across tenants, so a cached row is
often a site's only measurement that day.

## API-grounded probes

A probe (`lib/answers/openrouter-probe.ts`) asks one engine's model one
tracked prompt through OpenRouter (`OPENROUTER_API_KEY`), with web search
turned on. The prompt is the only message: no system prompt and no sampling
parameters.

**What a probe is not.** A consumer app (the ChatGPT app, Perplexity, Gemini,
Claude) has its own system prompt, memory, location and retrieval. A probe is
evidence about how the vendor's model answers with web grounding, not a
capture of what a signed-in buyer sees. Every engine carries a label that
says so, and the Engines card repeats it. The constant is `PROBE_LABEL` in
`lib/answers/engines.ts`.

| Engine | Default model (OpenRouter slug) | Search | Label |
|---|---|---|---|
| `chatgpt` | `openai/gpt-5-mini` | `openrouter:web_search` server tool, the vendor's native search | OpenAI model via API (not the ChatGPT app) |
| `perplexity` | `perplexity/sonar` | The model's own search | Perplexity Sonar via API (not the Perplexity app) |
| `gemini` | `google/gemini-2.5-flash` | Server tool, native search | Gemini model via API (not the Gemini app or AI Mode) |
| `claude` | `anthropic/claude-sonnet-5.5` | Server tool, native search | Claude model via API (not the Claude app) |

`AEO_ANSWER_ENGINES` overrides an engine's settings or adds one, and
`AEO_ANSWER_ENGINES_ENABLED` picks which run. A value that does not validate
stops the run with the reason instead of falling back to a default. The slugs
are tested only against fakes. Confirm them against OpenRouter's
`GET /api/v1/models` after deploy; a wrong slug fails its probes, which the
job records and skips.

- **What is recorded.** The answer text and its hash. The model that
  answered, plus how it searched (`model_version`, for example
  `openai/gpt-5-mini+web:native`). The sources, read from the response's
  annotations, then a top-level citations list, then links in the text.
  When an engine exposes none of these, `citations_observable` is false.
- **When probes run.** Every Tuesday at 10:00 UTC
  (`answers-sample-weekly`), for organisations with the `answer_probes`
  feature. It is off by default, and staff turn it on (or sample now) in
  Ops → Organisations.
- **What is asked.** The panel is up to `AEO_ANSWER_PANEL_SIZE` (25) tracked,
  non-excluded prompts, pinned first, then by demand, with
  `AEO_ANSWER_SAMPLES` probes (1 by default, at most 3) per prompt and
  engine.
- **What it costs.** Each probe holds its engine's estimate on the
  organisation's `answer_probe` budget and settles at the cost OpenRouter
  reports. A failed probe is skipped; a spent budget stops the run.
- **Repeats.** A same-day re-run reads the day's cached answer rather than
  paying again, and a retried step finds the row it already wrote. One
  observation counts per prompt, engine, sample and UTC day.

## Who is mentioned, listed and recommended

`lib/answers/mentions.ts` (`MENTION_EXTRACTOR_VERSION = "mentions-v0"`) reads
each answer for the brand, its products and the organisation's named
competitors, by name or alias, as whole words. It is deterministic, so every
answer is read the same way. The results go to `measure.answer_mentions`.

- **List rank.** Each numbered or bulleted item, or numbered heading, names
  the entity it mentions first. An entity's rank is that of the first item
  naming it. Titles ("Best Okta alternatives") and the detail under an item
  rank nothing.
- **Recommended.** The entity is first in a top-level list, or it is named in
  a sentence that recommends ("recommend", "best choice", "top pick",
  "ideal for", "stands out", …) with no negation in the three words before
  the cue ("I would not recommend", "avoid"). v0 counts every entity in such
  a sentence.

Sentiment, attributes and accuracy against verified facts are left for the
answer judge (`answer-judge-accuracy` in the roadmap). The judge columns are
already on the table.

## Shares and intervals

The Engines card (`lib/app/visibility.ts`, `ANSWERS_METHODOLOGY_VERSION =
"answers-v0"`) reports, per engine, over the last 28 days:

| Share | Of what |
|---|---|
| Mention rate | Answers naming the brand or one of its products, out of all answers |
| Recommendation Share | Answers recommending the brand, out of all answers |
| Citation Share | Answers citing one of our URLs, out of the answers whose sources were observable. An engine that hides its sources has no Citation Share rather than a zero one, and the card says "citations not observable via API". |
| Per competitor | Answers recommending each named competitor |

Every share is a proportion of answers (k of n), shown with a 95% Wilson score
interval (`lib/answers/stats.ts`). That interval stays inside 0–100% and
behaves at k = 0 and k = n, where the normal approximation does not. A probe
panel is small (25 prompts on one engine is n = 25 a week), so any engine
with fewer than 30 answers in the window (`LOW_N`) carries a low-n badge:
read the share as the range, not the point.

Answers vary from run to run, and wording changes them more than repeat runs
do. Until paraphrase panels and cluster-level statistics ship, treat a single
engine's week-to-week movement inside its interval as noise.

## Methodology versions and restatements

| Version | Covers | Where |
|---|---|---|
| `2026-10-r1` | Native AI Overview, Search Console, GA4 and crawl numbers, and how competitors are counted | `METHODOLOGY_VERSION`, `lib/app/methodology.ts` |
| `answers-v0` | Probe shares and their intervals | `lib/app/visibility.ts` |
| `mentions-v0` | Listed and recommended extraction | `lib/answers/mentions.ts` |
| `ev0-2026-10` | The queue's expected-value score (`scoreEV0`) | `lib/pipeline/opportunities.ts` |

When a change moves a number a customer has already seen, these steps follow:

1. The version moves, and the change is added to `METHODOLOGY_CHANGES`.
2. If the number is shown on a page, it is listed in `RESTATED_METRICS` with
   its reason.
3. A restatement records the old and new value per site. `computeRestatement`
   (`lib/app/restatement.ts`) runs the previous read models, kept only in
   `lib/app/methodology-legacy.ts`, next to the current ones, and writes one
   `app.metric_restatements` row per site, metric and version. Staff start it
   from `/ops` (*Restate metrics*, event `metrics/restatement.requested`),
   and the run is audited.
4. Strategy, Demand, Attribution and Refresh show a methodology note with
   each moved number, old and new, and the reason, for 60 days
   (`RESTATEMENT_NOTICE_DAYS`). Only numbers the page actually displays are
   restated, counted the way that page counts them.

The note is in-app only so far; an email restatement is still to come.

**What `2026-10-r1` changed** (the full list is in `METHODOLOGY_CHANGES`):

- AI Overview numbers come from our own SERP trackers only. Profound's
  answers from other engines are shown separately.
- Profound's Google AI Mode and Gemini rows are no longer filed as AI
  Overviews.
- A citation gap is judged on the question's latest snapshot, at most 45
  days old (`GAP_FRESHNESS_DAYS`). An older AI Overview no longer keeps a
  closed gap open.
- The refresh scan counts AI Overview citations only; an organic ranking
  used to count.
- Search Console clicks and GA4 sessions are tied to each published asset
  through the page they name (`resolveMetricContentIds`). Per-asset numbers
  used to read 0.
- The site's Search Console click total counts each click once (page rows
  only).
- Crawler hits roll up over whole UTC days, and a day's count never goes
  down.
- Excluded questions, paused sites and organisations whose plan has lapsed
  are no longer tracked.
- Competitors are the rivals you name. Forums, review platforms, reference
  sites and publishers are sources shaping answers, and count for less in
  the queue.
- Every answer is labelled with its engine and method, and our probes are
  reported per engine, never added to the AI Overview or Profound numbers.

## Changing a metric or adding a source

- **A new collector** picks a `collection_method` and an `engine`, writes
  through `recordSnapshot` or `recordAnswerObservation`, and is read through
  a view filtered to its method. Nothing joins `v_native_aio` unless it is a
  SERP row from our own trackers. A new method gets its own card or column,
  labelled, never a share of an existing one.
- **A change that moves a displayed number** bumps the version, lists the
  change and the restated metric, and adds a test pinning the new rule
  (`tests/db` when it depends on SQL semantics).
