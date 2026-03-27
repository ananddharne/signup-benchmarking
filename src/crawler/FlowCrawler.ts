import { z } from 'zod'
import type { Page } from '@playwright/test'
import type { Stagehand } from '@browserbasehq/stagehand'
import type { MetricsCollector } from '../metrics/MetricsCollector'
import { PageClassificationSchema, type PageType } from '../schemas/page'
import type { StepData } from '../schemas/metrics'
import type { StoppedReason } from '../schemas/report'

const POST_NAV_TIMEOUT = 10_000

const DUMMY_USER = {
  firstName: 'Alex',
  lastName: 'Bench',
  fullName: 'Alex Bench',
  username: 'alexbench',
  company: 'Benchmark Co',
  password: 'Bench!2024x',
  phone: '2025550123',
  birthday: { month: 'January', day: '15', year: '1990' },
  gender: 'male',
  role: 'Software Engineer',
  companySize: '11-50',
  country: 'United States',
  hearAboutUs: 'Search engine',
}

const ValidationErrorSchema = z.object({
  hasErrors: z.boolean(),
  errors: z.array(z.string()),
})

interface FlowCrawlerOptions {
  stagehand: Stagehand
  page: Page
  pwPage?: Page
  collector: MetricsCollector
  maxSteps?: number
  stepTimeoutMs?: number
}

type StepResult =
  | { stop: true; stoppedReason: StoppedReason }
  | { stop: false; stepData: StepData }
  | { timeout: true }

export class FlowCrawler {
  private stagehand: Stagehand
  private page: Page
  private pwPage: Page | undefined
  private collector: MetricsCollector
  private maxSteps: number
  private stepTimeoutMs: number

  constructor(options: FlowCrawlerOptions) {
    this.stagehand = options.stagehand
    this.page = options.page
    this.pwPage = options.pwPage
    this.collector = options.collector
    this.maxSteps = options.maxSteps ?? 20
    this.stepTimeoutMs = options.stepTimeoutMs ?? 30_000
  }

  async crawl(url: string): Promise<{ steps: StepData[]; stoppedReason: StoppedReason }> {
    const steps: StepData[] = []
    let stoppedReason: StoppedReason = 'max_steps_reached'

    try {
      await this.page.addInitScript(() => {
        ;(window as any).__clickCount = 0
        document.addEventListener('click', () => (window as any).__clickCount++, true)
      })
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await this.pwPage?.waitForLoadState('networkidle', { timeout: POST_NAV_TIMEOUT }).catch(() => {})

      // Dismiss cookie/GDPR banners only — do NOT click sign-in, login, or account dialogs
      await this.stagehand.act(
        'If there is a cookie consent banner, GDPR privacy notice, or tracking preference dialog visible (typically a bar or overlay asking about cookies or privacy preferences), click the accept or dismiss button to close it. Do NOT interact with sign-in, login, account creation, or subscription dialogs.'
      ).catch(() => {})

      let consecutiveSameUrl = 0
      let lastUrl = ''

      for (let i = 0; i < this.maxSteps; i++) {
        const result = await Promise.race([
          this.executeStep(i),
          new Promise<{ timeout: true }>((resolve) =>
            setTimeout(() => resolve({ timeout: true }), this.stepTimeoutMs)
          ),
        ])

        if ('timeout' in result) {
          stoppedReason = 'error'
          break
        }

        if (result.stop) {
          stoppedReason = result.stoppedReason
          break
        }

        steps.push(result.stepData)

        if (result.stepData.pageType === 'signup_form') {
          stoppedReason = 'signup_completed'
          break
        }

        const currentUrl = result.stepData.url
        if (currentUrl === lastUrl) {
          consecutiveSameUrl++
          if (consecutiveSameUrl >= 5) {
            console.warn(`[FlowCrawler] URL unchanged for 5 consecutive steps, stopping`)
            stoppedReason = 'unclassifiable_page'
            break
          }
        } else {
          consecutiveSameUrl = 0
          lastUrl = currentUrl
        }
      }
    } catch (err) {
      console.error('[FlowCrawler] error:', err)
      stoppedReason = 'error'
    }

    return { steps, stoppedReason }
  }

  private async executeStep(index: number): Promise<StepResult> {
    await this.collector.startStep()

    const classification = await this.stagehand.extract(
      'Classify this page in the context of a SaaS signup/onboarding flow.',
      PageClassificationSchema,
    )

    const effectiveType: PageType =
      classification.confidence === 'low' ? 'unknown' : classification.pageType

    const ALWAYS_TERMINAL: PageType[] = [
      'oauth_consent', 'email_verification', 'captcha', 'payment', 'dashboard',
    ]

    if (classification.isTerminal || effectiveType === 'unknown' || ALWAYS_TERMINAL.includes(effectiveType)) {
      return { stop: true, stoppedReason: this.resolveStoppedReason(effectiveType) }
    }

    await this.collector.snapshotBeforeDispatch()
    await this.dispatch(effectiveType)

    // Wait for SPA/page transitions to settle after navigation or interaction
    await this.pwPage?.waitForLoadState('networkidle', { timeout: POST_NAV_TIMEOUT }).catch(() => {})

    const metrics = await this.collector.endStep()
    const stepData: StepData = {
      stepIndex: index,
      pageType: effectiveType,
      url: this.page.url(),
      metrics,
    }

    return { stop: false, stepData }
  }

  private resolveStoppedReason(pageType: PageType): StoppedReason {
    const map: Partial<Record<PageType, StoppedReason>> = {
      dashboard: 'dashboard_reached',
      login_form: 'login_redirect',
      oauth_consent: 'oauth_wall',
      email_verification: 'email_verification_wall',
      captcha: 'captcha_detected',
      payment: 'payment_wall',
      unknown: 'unclassifiable_page',
    }
    return map[pageType] ?? 'unclassifiable_page'
  }

  private async dispatch(pageType: PageType): Promise<void> {
    switch (pageType) {
      case 'signup_form':
        await this.handleSignupForm()
        break
      case 'login_form':
        // Some sites use a combined login/signup page — try to find a create account path
        await this.stagehand.act('Click the create account, sign up, register, or join button to proceed to account creation. Do not fill in the login form.')
        this.collector.recordInteraction()
        break
      case 'landing':
        await this.stagehand.act('Click the continue, get started, or sign up button to proceed.')
        this.collector.recordInteraction()
        break
      case 'onboarding_step':
      case 'onboarding_survey':
      case 'workspace_setup':
        await this.stagehand.act(
          `Fill in any visible text input or selection fields with reasonable placeholder values ` +
          `(e.g. name → "${DUMMY_USER.firstName}", company → "${DUMMY_USER.company}", ` +
          `role → "${DUMMY_USER.role}", age → "30", number → "1"). Skip fields that are already filled.`
        ).catch(() => {})
        await this.stagehand.act('Click the next, continue, or skip button to advance.')
        this.collector.recordInteraction()
        break
      case 'plan_selection':
        await this.stagehand.act('Select the free plan if one is available, otherwise click continue or skip.')
        this.collector.recordInteraction()
        break
    }
  }

  private async handleSignupForm(): Promise<void> {
    const ts = Date.now()
    const email = `bench+${ts}@example.com`
    const username = `${DUMMY_USER.username}${ts}`

    const formUrl = this.page.url()

    // Fill each field individually — act() is a single action; missing fields are skipped automatically.
    // guardNav=true: if act() accidentally navigates away (LLM clicks a link), go back to the form.
    const tryAct = async (instruction: string, guardNav = true) => {
      try {
        await this.stagehand.act(instruction)
        this.collector.recordInteraction()
        if (guardNav) {
          // Wait briefly for any click-triggered navigation to settle, then check via the direct Playwright page
          await this.pwPage?.waitForLoadState('domcontentloaded', { timeout: 3_000 }).catch(() => {})
          const currentUrl = this.pwPage?.url() ?? this.page.url()
          if (currentUrl !== formUrl) {
            console.warn('[FlowCrawler] act() navigated away from form, going back')
            await this.page.goto(formUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
            await this.pwPage?.waitForLoadState('networkidle', { timeout: POST_NAV_TIMEOUT }).catch(() => {})
          }
        }
      } catch (err) {
        console.warn('[FlowCrawler] act() skipped (field likely absent):', (err as Error).message?.slice(0, 80))
      }
    }

    // Single extract to detect all present fields — avoids wasted act() calls and reduces API requests
    const FormFieldsSchema = z.object({
      firstName: z.boolean(),
      lastName: z.boolean(),
      fullName: z.boolean(),
      username: z.boolean(),
      email: z.boolean(),
      phone: z.boolean(),
      password: z.boolean(),
      confirmPassword: z.boolean(),
      birthday: z.boolean(),
      gender: z.boolean(),
      company: z.boolean(),
      role: z.boolean(),
      companySize: z.boolean(),
      country: z.boolean(),
      hearAboutUs: z.boolean(),
      tosCheckbox: z.boolean(),
    })
    const fields = await this.stagehand.extract(
      'Identify which of the following input fields or controls are present on this signup form. Return true for each that exists.',
      FormFieldsSchema,
    )

    if (fields.firstName && fields.lastName) {
      await tryAct(`Fill in the first name field with "${DUMMY_USER.firstName}".`)
      await tryAct(`Fill in the last name field with "${DUMMY_USER.lastName}".`)
    } else if (fields.fullName) {
      await tryAct(`Fill in the full name or display name field with "${DUMMY_USER.fullName}".`)
    }
    if (fields.username)        await tryAct(`Fill in the username field with "${username}".`)
    if (fields.email)           await tryAct(`Fill in the email field with "${email}".`)
    if (fields.phone && !fields.email) await tryAct(`Fill in the phone or mobile number field with "${DUMMY_USER.phone}".`)
    if (fields.company)         await tryAct(`Fill in the company or organization field with "${DUMMY_USER.company}".`)
    if (fields.password)        await tryAct(`Fill in the password field with "${DUMMY_USER.password}".`)
    if (fields.confirmPassword) {
      // Stagehand frequently can't find confirm password in cross-frame pages; use Playwright as primary
      let confirmed = false
      if (this.pwPage) {
        const inputs = await this.pwPage.locator('input[type="password"]').all()
        if (inputs.length >= 2) {
          await inputs[1].fill(DUMMY_USER.password).catch(() => {})
          confirmed = true
        }
      }
      if (!confirmed) await tryAct(`Fill in the confirm password field with "${DUMMY_USER.password}".`)
    }
    if (fields.birthday) {
      // Try Playwright select for native <select> dropdowns first (avoids Stagehand schema errors on selectOptionFromDropdown)
      let birthdayHandled = false
      if (this.pwPage) {
        const selects = await this.pwPage.locator('select').all()
        if (selects.length >= 3) {
          // Typical pattern: month / day / year — try each in order
          const values = [DUMMY_USER.birthday.month, DUMMY_USER.birthday.day, DUMMY_USER.birthday.year]
          for (let i = 0; i < Math.min(selects.length, 3); i++) {
            await selects[i].selectOption({ label: values[i] }).catch(async () => {
              await selects[i].selectOption({ value: values[i] }).catch(() => {})
            })
          }
          birthdayHandled = true
        }
      }
      if (!birthdayHandled) {
        await tryAct(`Select or fill in the birthday using month "${DUMMY_USER.birthday.month}", day "${DUMMY_USER.birthday.day}", year "${DUMMY_USER.birthday.year}".`)
      }
    }
    if (fields.gender)          await tryAct(`Select gender as "${DUMMY_USER.gender}".`)
    if (fields.role)            await tryAct(`Select or fill in the role or job title field with "${DUMMY_USER.role}".`)
    if (fields.companySize)     await tryAct(`Select or fill in the company size field with "${DUMMY_USER.companySize}".`)
    if (fields.country)         await tryAct(`Select or fill in the country or region field with "${DUMMY_USER.country}".`)
    if (fields.hearAboutUs)     await tryAct(`Select or fill in the "how did you hear about us" field with "${DUMMY_USER.hearAboutUs}".`)
    if (fields.tosCheckbox) {
      // Use Playwright directly — ToS labels often navigate away when clicked via LLM
      const boxes = this.pwPage ? await this.pwPage.locator('input[type="checkbox"]').all() : []
      let checkedAny = false
      for (const box of boxes) {
        if (!(await box.isChecked().catch(() => true))) {
          await box.check({ force: true }).catch(() => {})
          checkedAny = true
        }
      }
      if (!checkedAny) await tryAct('Find the terms of service, privacy policy, or user agreement checkbox and click it to check it.')
    }
    // Use Playwright directly for submit — Stagehand frequently fails with cross-frame element IDs
    // or "no actionable element" without throwing, making try/catch unreliable
    if (this.pwPage) {
      let clicked = false
      // Prefer explicit submit type first
      const submitBtn = this.pwPage.locator('button[type="submit"], input[type="submit"]').first()
      if (await submitBtn.count() > 0) {
        await submitBtn.click({ force: true }).catch(() => {})
        clicked = true
        console.log('[FlowCrawler] Submit via button[type=submit]')
      }
      if (!clicked) {
        // Fall back to button text matching
        for (const btn of await this.pwPage.locator('button').all()) {
          const text = (await btn.textContent().catch(() => '')).toLowerCase()
          if (['sign up', 'create account', 'register', 'submit', 'join now', 'join', 'next', 'continue'].some(t => text.includes(t))) {
            await btn.click({ force: true }).catch(() => {})
            clicked = true
            console.log('[FlowCrawler] Submit via button text:', text)
            break
          }
        }
      }
      if (!clicked) {
        // Last resort: Stagehand
        await tryAct('Submit the form by clicking the submit, sign up, create account, register, or next/continue button.', false)
      } else {
        this.collector.recordInteraction()
      }
    } else {
      await tryAct('Submit the form by clicking the submit, sign up, create account, register, or next/continue button.', false)
    }
    await this.pwPage?.waitForLoadState('networkidle', { timeout: POST_NAV_TIMEOUT }).catch(() => {})

    const validation = await this.stagehand.extract(
      'Look for any visible form validation errors, field-level error messages, or alert banners indicating a problem with the form submission (e.g. "email already taken", "invalid password", "username unavailable"). Return hasErrors: false if the form submitted successfully or the page changed.',
      ValidationErrorSchema,
    )

    if (validation.hasErrors && validation.errors.length > 0) {
      console.warn('[FlowCrawler] Validation errors detected:', validation.errors)
    }
  }
}
