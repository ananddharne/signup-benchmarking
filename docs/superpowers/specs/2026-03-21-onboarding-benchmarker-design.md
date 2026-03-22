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
  └─ pure function: StepData[] + BuildMeta → CrawlReport (Zod-validated)

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

`confidence` usage: if `'low'`, `FlowCrawler` treats the page as `'unknown'` and stops with `stoppedReason: 'unclassifiable_page'`.

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
  hasMagicLink: z.boolean(),
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
const StoppedReason = z.enum([
  'dashboard_reached',
  'email_verification_wall',
  'oauth_wall',
  'payment_wall',
  'captcha_detected',
  'login_redirect',
  'max_steps_reached',
  'unclassifiable_page',
  'error'
])

const CrawlReport = z.object({
  url: z.string(),
  category: z.string().optional(),
  crawledAt: z.string().datetime(),
  completedSuccessfully: z.boolean(),
  stoppedReason: StoppedReason,
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

## Component Interfaces

### `CrawlRunner`

```typescript
interface CrawlRunnerOptions {
  email?: string
  timeoutMs?: number  // per-step timeout, default 30_000
}

class CrawlRunner {
  constructor(options: CrawlRunnerOptions) {}
  async run(url: string, category?: string): Promise<CrawlReport>
}
```

### `FlowCrawler`

```typescript
interface FlowCrawlerOptions {
  stagehand: Stagehand
  collector: MetricsCollector
  email?: string
  maxSteps?: number      // default 20
  stepTimeoutMs?: number // default 30_000
}

class FlowCrawler {
  constructor(options: FlowCrawlerOptions) {}
  async crawl(url: string): Promise<{ steps: StepData[]; stoppedReason: StoppedReason }>
}
```

### `MetricsCollector`

```typescript
class MetricsCollector {
  constructor(page: Page) {}
  async startStep(): Promise<void>   // async: snapshots window.__clickCount via page.evaluate()
  async endStep(): Promise<StepMetrics>
}
```

### `ReportBuilder`

```typescript
interface BuildMeta {
  url: string
  category?: string
  crawledAt: string       // ISO 8601 string: new Date().toISOString()
  emailUsed?: string
  stoppedReason: StoppedReason
}

class ReportBuilder {
  static build(steps: StepData[], meta: BuildMeta): CrawlReport
}
```

`ReportBuilder.build()` handles empty or partial `steps[]` gracefully: all summary numeric fields default to `0`, array fields default to `[]`, boolean flags default to `false`. Empty `steps` is valid — the report is still Zod-parseable.

`completedSuccessfully` is derived as `meta.stoppedReason === 'dashboard_reached'`. It is not passed explicitly in `BuildMeta`.

`summary.oauthProviders` is the deduplicated union of `oauthProviders` across all steps (same provider on multiple steps appears once).

---

## FlowCrawler Step Loop

**Initialization:**
- Inject click counter script via `addInitScript` (capture phase, survives navigations):
  ```javascript
  window.__clickCount = 0
  document.addEventListener('click', () => window.__clickCount++, true)
  ```
- Navigate to starting URL

**Loop (max 20 steps, default per-step timeout 30s):**

1. `await collector.startStep()`
2. Classify page → `PageClassification` via `stagehand.extract()` with `PageClassification` schema
3. If `confidence === 'low'` → treat as `'unknown'`
4. If `isTerminal` → break, record `stoppedReason`. Terminal pages are **not** appended to `steps[]` — the break skips `endStep()` and `StepData` collection. The terminal `pageType` is therefore not included in `summary.flowPath`.
5. Act based on `pageType`:
   - `landing` → two-pass CTA detection (see below)
   - `signup_form` → fill form with dummy data + `--email` value, submit
   - `login_form` → stop, `stoppedReason: 'login_redirect'`
   - `oauth_consent` → record providers, stop, `stoppedReason: 'oauth_wall'`
   - `email_verification` → stop, `stoppedReason: 'email_verification_wall'`
   - `onboarding_step` / `onboarding_survey` / `workspace_setup` → advance (Next / Continue / Skip)
   - `plan_selection` → select free tier if present, else skip
   - `payment` → stop, `stoppedReason: 'payment_wall'`
   - `dashboard` → stop, `stoppedReason: 'dashboard_reached'`, `completedSuccessfully: true`
   - `unknown` → stop, `stoppedReason: 'unclassifiable_page'`
6. `const metrics = await collector.endStep()`
7. Append `StepData` to `steps[]`

If step times out (per-step timeout exceeded): stop loop, `stoppedReason: 'error'`, emit partial report.

**After loop:** pass `steps[]` and metadata to `ReportBuilder.build()` → `CrawlReport` → Zod parse → return.

**Error handling:** Any thrown error in the loop catches, sets `stoppedReason: 'error'`, calls `ReportBuilder.build()` with steps collected so far (may be empty array), returns partial report.

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

**Click counting:** `addInitScript` injects `window.__clickCount = 0` with a capture-phase listener. `startStep()` calls `page.evaluate(() => window.__clickCount)` to snapshot the value. `endStep()` calls `evaluate` again and diffs.

**Metric collection at `endStep()`:**

| Metric | Method |
|---|---|
| Click delta | `page.evaluate()` diff on `window.__clickCount` |
| Form fields | `page.$$eval('input, select, textarea', ...)` — label via `aria-label`, `<label for>`, placeholder fallback |
| OAuth providers | `page.$$eval('a, button', ...)` — pattern match text/href against `['google', 'github', 'microsoft', 'apple', 'slack', 'okta', 'saml']` |
| Magic link | `page.$$eval('a, button', ...)` — pattern match text against `['magic link', 'passwordless', 'email me a link', 'sign in with email']` → `boolean` |
| Page load time | `performance.getEntriesByType('navigation')[0].duration` — null if no navigation since last step |
| Step duration | `Date.now()` diff between `startStep()` / `endStep()` |
| Axe-core | `new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa']).analyze()` |
| Interactive elements | `page.$$eval('[role=button], button, a, input, select, textarea', els => els.length)` |
| DOM nodes | `document.querySelectorAll('*').length` |

---

## CLI

**Single URL:**
```
npm run crawl -- --url https://airtable.com --email test@example.com
```
Output: `reports/{sanitized-url}-{timestamp}.json`

**Batch (CSV with `category,url` headers):**
```
npm run crawl -- --csv sites.csv --email test@example.com
```
Output per row: `reports/{category}-{sanitized-url}-{timestamp}.json`

The `crawl` script is defined in `package.json` as `tsx src/cli.ts`. The `tsx` package handles TypeScript execution at runtime; `ts-node` is not used.

**Timestamp format:** Unix epoch milliseconds (e.g., `1742563800000`). Safe across all operating systems and shells. `CrawlRunner` captures `const now = new Date()` at crawl start and uses `now.toISOString()` for `BuildMeta.crawledAt` and `now.getTime()` for the filename — same instant, different formats.

**URL sanitization rule:** strip protocol (`https://`), replace any character that is not alphanumeric or hyphen with a hyphen, collapse consecutive hyphens, truncate to 60 characters. Example: `https://app.airtable.com/signup` → `app-airtable-com-signup`.

**CSV batch:** iterates rows sequentially (no parallelism in v1). Writes one report file per row. Continues to next URL if a crawl errors.

---

## Testing Strategy

**Unit / TDD (deterministic — test strictly):**

| Test file | What it covers |
|---|---|
| `tests/unit/metrics.test.ts` | Each `MetricsCollector` method against `page.setContent()` mock DOM |
| `tests/unit/report.test.ts` | `ReportBuilder.build()` aggregation with fixture `StepData[]`; empty steps case |
| `tests/unit/schemas.test.ts` | Zod schemas: valid + invalid inputs, edge cases (null pageLoadMs, empty steps, all stoppedReason values) |
| `tests/unit/dispatch.test.ts` | FlowCrawler page-type dispatch with mocked Stagehand + MetricsCollector |

**Acceptance-level (shape assertions only):**

| Test file | What it covers |
|---|---|
| `tests/acceptance/crawl.test.ts` | Full crawl against Airtable. Asserts: report parses Zod schema, `steps.length > 0`, `flowPath` contains `'landing'`, `stoppedReason` is a known enum value |

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
