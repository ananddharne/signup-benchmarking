import type { Page } from 'playwright'
import { AxeBuilder } from '@axe-core/playwright'
import type { StepMetrics, FormField } from '../schemas/metrics'

const OAUTH_PATTERNS = ['google', 'github', 'microsoft', 'apple', 'slack', 'okta', 'saml']
const MAGIC_LINK_PATTERNS = ['magic link', 'passwordless', 'email me a link', 'sign in with email']

export class MetricsCollector {
  private page: Page
  private stepStartTime = 0
  private clickCountAtStart = 0
  private navStartTimeAtStart = 0

  constructor(page: Page) {
    this.page = page
  }

  async startStep(): Promise<void> {
    this.stepStartTime = Date.now()
    this.clickCountAtStart = await this.page.evaluate(
      () => (window as any).__clickCount ?? 0
    )
    this.navStartTimeAtStart = await this.page.evaluate(() => {
      const entry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
      return entry ? entry.startTime : 0
    })
  }

  async endStep(): Promise<StepMetrics> {
    const [
      clickCountNow,
      formFields,
      oauthProviders,
      hasMagicLink,
      pageLoadMs,
      a11yResult,
      interactiveElements,
      domNodeCount,
    ] = await Promise.all([
      this.page.evaluate(() => (window as any).__clickCount ?? 0),
      this.collectFormFields(),
      this.collectOAuthProviders(),
      this.detectMagicLink(),
      this.collectPageLoadMs(),
      this.collectA11y(),
      this.page.$$eval(
        '[role=button], button, a, input, select, textarea',
        els => els.length
      ),
      this.page.evaluate(() => document.querySelectorAll('*').length),
    ])

    return {
      clickCount: clickCountNow - this.clickCountAtStart,
      formFields,
      oauthProviders,
      hasMagicLink,
      pageLoadMs,
      stepDurationMs: Date.now() - this.stepStartTime,
      a11yViolations: a11yResult.violations.length,
      a11yCritical: a11yResult.violations.filter(v => v.impact === 'critical').length,
      a11ySerious: a11yResult.violations.filter(v => v.impact === 'serious').length,
      interactiveElements,
      domNodeCount,
    }
  }

  private async collectFormFields(): Promise<FormField[]> {
    return this.page.$$eval('input, select, textarea', (els) => {
      return els.map(el => {
        const input = el as HTMLInputElement
        const id = input.id

        // Try <label for="id">
        let label = ''
        if (id) {
          const labelEl = document.querySelector(`label[for="${id}"]`)
          if (labelEl) label = labelEl.textContent?.trim() ?? ''
        }
        // Fallback: aria-label
        if (!label) label = input.getAttribute('aria-label')?.trim() ?? ''
        // Fallback: placeholder
        if (!label) label = input.getAttribute('placeholder')?.trim() ?? ''

        return {
          label,
          type: input.type || input.tagName.toLowerCase(),
          required: input.required ?? false,
        }
      })
    })
  }

  private async collectOAuthProviders(): Promise<string[]> {
    const patterns = ['google', 'github', 'microsoft', 'apple', 'slack', 'okta', 'saml']
    return this.page.$$eval('a, button', (els, patterns) => {
      const found = new Set<string>()
      for (const el of els) {
        const text = (el.textContent ?? '').toLowerCase()
        const href = (el as HTMLAnchorElement).href?.toLowerCase() ?? ''
        for (const p of patterns) {
          if (text.includes(p) || href.includes(p)) found.add(p)
        }
      }
      return Array.from(found)
    }, patterns)
  }

  private async detectMagicLink(): Promise<boolean> {
    const patterns = ['magic link', 'passwordless', 'email me a link', 'sign in with email']
    return this.page.$$eval('a, button', (els, patterns) => {
      for (const el of els) {
        const text = (el.textContent ?? '').toLowerCase()
        for (const p of patterns) {
          if (text.includes(p)) return true
        }
      }
      return false
    }, patterns)
  }

  private async collectPageLoadMs(): Promise<number | null> {
    return this.page.evaluate((navStartAtStepBegin) => {
      const entry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
      if (!entry) return null
      // Return duration only if a new navigation happened since startStep()
      if (entry.startTime <= navStartAtStepBegin) return null
      return entry.duration
    }, this.navStartTimeAtStart)
  }

  private async collectA11y() {
    try {
      return await new AxeBuilder({ page: this.page as any })
        .withTags(['wcag2a', 'wcag2aa'])
        .analyze()
    } catch {
      return { violations: [] }
    }
  }
}
