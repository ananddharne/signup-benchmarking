# Onboarding Benchmarker — Design Spec

**Date:** 2026-03-21
**Status:** Approved

---

## Overview

A CLI tool that automatically crawls arbitrary website signup/onboarding flows and produces quantitative UX benchmark reports. Given a URL (or a CSV of URLs), it navigates the full signup flow from landing page through account creation, collecting structured metrics at every step, and writes a validated JSON report.

**Scope:** CLI tool only. Domain logic is cleanly separated from I/O so it can be extracted for a future API/service layer, but no seams or abstractions are added speculatively (YAGNI).

---

## Architecture

Four layers, each with a single clear purpose:

```
CLI (src/cli.ts)
  └─ parses args / CSV, calls CrawlRunner per URL, writes JSON output files

CrawlRunner (src/crawler/CrawlRunner.ts)
  └─ initializes Stagehand + MetricsCollector, calls FlowCrawler, calls ReportBuilder

FlowCrawler (src/crawler/FlowCrawler.ts)
  └─ step loop: classify → check terminal → act → collect metrics
  └─ returns StepData[]

MetricsCollector (src/metrics/MetricsCollector.ts)
  └─ pure Playwright instrumentation, never navigates
  └─ startStep() / endStep() bracket pattern

ReportBuilder (src/report/ReportBuilder.ts)
  └─ pure function: StepData[] + metadata → CrawlReport (Zod-validated)

Zod schemas (src/schemas/)
  └─ dual-use: Stagehand extract() schemas + report validation
```

**Data flow:** CLI → CrawlRunner → FlowCrawler (step loop) → MetricsCollector (per step) → ReportBuilder → JSON file.

---

## Tech Stack

- **Stagehand** (`@browserbasehq/stagehand`) — AI-powered navigation via `act()`, `extract()`, `observe()`
- **Playwright** — deterministic browser instrumentation underneath Stagehand
- **Zod** — typed extraction schemas + report validation
- **axe-core** (`@axe-core/playwright`) — WCAG 2.1 AA accessibility audits
- **TypeScript / Node.js**
- **Vitest** — test runner
- **Anthropic Claude** — Stagehand's LLM backend (vision used implicitly by Stagehand; no explicit vision API calls in this version)

---

## Zod Schemas

### `src/schemas/page.ts`

```typescript
const PageType = z.enum([
  'landing', 'signup_form', 'login_form', 'oauth_consent',
  'email_verification', 'onboarding_step', 'onboarding_survey',
  'workspace_setup', 'plan_selection', 'payment', 'dashboard', 'unknown'
])

const PageClassification = z.object({
  pageType: PageType,
  isTerminal: z.boolean(),
  confidence: z.enum(['high', 'medium', 'low']),
  reason: z.string()
})
```

### `src/schemas/metrics.ts`

```typescript
const FormField = z.object({
  label: z.string(),
  type: z.string(),
  required: z.boolean()
})

const StepMetrics = z.object({
  clickCount: z.number(),
  formFields: z.array(FormField),
  oauthProviders: z.array(z.string()),
  pageLoadMs: z.number().nullable(),
  stepDurationMs: z.number(),
  a11yViolations: z.number(),
  a11yCritical: z.number(),
  a11ySerious: z.number(),
  interactiveElements: z.number(),
  domNodeCount: z.number()
})

const StepData = z.object({
  stepIndex: z.number(),
  pageType: PageType,
  url: z.string(),
  metrics: StepMetrics
})
```

### `src/schemas/report.ts`

```typescript
const CrawlReport = z.object({
  url: z.string(),
  category: z.string().optional(),
  crawledAt: z.string().datetime(),
  completedSuccessfully: z.boolean(),
  stoppedReason: z.enum([
    'dashboard_reached', 'email_verification_wall', 'captcha_detected',
    'max_steps_reached', 'unclassifiable_page', 'error'
  ]),
  steps: z.array(StepData),
  summary: z.object({
    totalSteps: z.number(),
    totalClicks: z.number(),
    totalFormFields: z.number(),
    totalTimeMs: z.number(),
    oauthProviders: z.array(z.string()),
    hasSso: z.boolean(),
    hasMagicLink: z.boolean(),
    requiresEmailVerification: z.boolean(),
    requiresPayment: z.boolean(),
    requiresOnboardingSurvey: z.boolean(),
    totalA11yViolations: z.number(),
    flowPath: z.array(PageType)
  }),
  emailUsed: z.string().optional()
})
```

---

## FlowCrawler Step Loop

**Initialization:**
- Inject click counter script via `addInitScript` (capture phase, survives navigations)
- Navigate to starting URL

**Loop (max 20 steps):**

1. `collector.startStep()`
2. Classify page → `PageClassification` via `stagehand.extract()` with `PageClassification` schema
3. If `isTerminal` → break, record `stoppedReason`
4. Act based on `pageType`:
   - `landing` → two-pass CTA detection (see below)
   - `signup_form` → fill form with dummy data + `--email` value, submit
   - `oauth_consent` → record providers, stop (`email_verification_wall`)
   - `onboarding_step` / `onboarding_survey` / `workspace_setup` → advance (Next / Continue / Skip)
   - `plan_selection` → select free tier if present, else skip
   - `payment` → stop, `stoppedReason: 'dashboard_reached'` is wrong — record as terminal
   - `email_verification` → stop, `stoppedReason: 'email_verification_wall'`
   - `unknown` → stop, `stoppedReason: 'unclassifiable_page'`
5. `collector.endStep()` → `StepMetrics`
6. Append `StepData` to `steps[]`

**After loop:** `ReportBuilder.build(steps, meta)` → `CrawlReport` → Zod parse → return.

**Error handling:** Any thrown error catches, sets `stoppedReason: 'error'`, emits partial report with steps collected so far.

**Two-pass CTA detection (landing pages only):**
1. `extract()` with schema `{ signupUrl: z.string().optional(), signupText: z.string().optional() }` — structured, fast
2. If nothing found: `act('click the sign up or get started button')` — broader fallback

**Dummy user data (hardcoded constants):**
```typescript
const DUMMY_USER = {
  name: 'Alex Bench',
  company: 'Benchmark Co',
  password: 'Bench!2024x'
  // email from --email CLI flag
}
```

---

## MetricsCollector

Pure Playwright instrumentation. Stateless between crawls — new instance per `CrawlRunner` invocation.

**Interface:**
```typescript
class MetricsCollector {
  constructor(page: Page) {}
  startStep(): void
  async endStep(): Promise<StepMetrics>
}
```

**Click counting:** `addInitScript` injects `window.__clickCount = 0` with a capture-phase listener. `startStep()` snapshots, `endStep()` diffs.

**Metric collection at `endStep()`:**

| Metric | Method |
|---|---|
| Click delta | `window.__clickCount` diff |
| Form fields | `page.$$eval('input, select, textarea', ...)` — label via `aria-label`, `<label for>`, placeholder fallback |
| OAuth providers | `page.$$eval('a, button', ...)` — pattern match text/href against `['google', 'github', 'microsoft', 'apple', 'slack', 'okta', 'saml']` |
| Page load time | `performance.getEntriesByType('navigation')[0].duration` — null if no navigation |
| Step duration | `Date.now()` diff |
| Axe-core | `new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa']).analyze()` |
| Interactive elements | `page.$$eval('[role=button], button, a, input, select, textarea', ...)` |
| DOM nodes | `document.querySelectorAll('*').length` |

---

## CLI

**Single URL:**
```
npx ts-node src/cli.ts --url https://airtable.com --email test@example.com
```

**Batch (CSV with `category,url` headers):**
```
npx ts-node src/cli.ts --csv sites.csv --email test@example.com
```

CSV batch: iterates rows sequentially, calls `CrawlRunner` once per URL, writes one report file per row: `reports/{category}-{sanitized-url}-{timestamp}.json`.

**Output:** JSON file(s) in `./reports/` directory.

---

## Testing Strategy

**Unit / TDD (deterministic — test strictly):**

| Test file | What it covers |
|---|---|
| `tests/unit/metrics.test.ts` | Each `MetricsCollector` method against `page.setContent()` mock DOM |
| `tests/unit/report.test.ts` | `ReportBuilder` aggregation with fixture `StepData[]` arrays |
| `tests/unit/schemas.test.ts` | Zod schemas: valid + invalid inputs, edge cases |
| `tests/unit/dispatch.test.ts` | FlowCrawler page-type dispatch with mocked Stagehand + MetricsCollector |

**Acceptance-level (shape assertions only):**

| Test file | What it covers |
|---|---|
| `tests/acceptance/crawl.test.ts` | Full crawl against Airtable (or similar). Asserts report parses Zod schema, `steps.length > 0`, `flowPath` contains `'landing'`, `stoppedReason` is a known enum value |

---

## File Layout

```
src/
  cli.ts
  crawler/
    CrawlRunner.ts
    FlowCrawler.ts
  metrics/
    MetricsCollector.ts
  report/
    ReportBuilder.ts
  schemas/
    page.ts
    metrics.ts
    report.ts
tests/
  unit/
    metrics.test.ts
    report.test.ts
    schemas.test.ts
    dispatch.test.ts
  acceptance/
    crawl.test.ts
reports/           (gitignored, output destination)
```

---

## Future Extensions (out of scope for v1)

- **Email verification:** Integrate disposable email API (Mailosaur, Guerrilla Mail) to receive and parse verification links. `--email` flag already provides the seam.
- **CAPTCHA detection:** Single targeted vision API call in FlowCrawler's terminal-check logic.
- **Parallelism:** Run multiple URLs concurrently in batch mode.
- **SaaS layer:** Extract `CrawlRunner` + schemas as a library; wrap in API/queue layer.
- **Longitudinal comparison:** Store reports and diff across runs.
