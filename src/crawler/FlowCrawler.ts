import { z } from 'zod'
import type { Stagehand } from '@browserbasehq/stagehand'
import type { MetricsCollector } from '../metrics/MetricsCollector'
import { PageClassificationSchema, type PageType } from '../schemas/page'
import type { StepData } from '../schemas/metrics'
import type { StoppedReason } from '../schemas/report'

const DUMMY_USER = {
  name: 'Alex Bench',
  company: 'Benchmark Co',
  password: 'Bench!2024x',
}

const CtaSchema = z.object({
  signupUrl: z.string().optional(),
  signupText: z.string().optional(),
})

interface FlowCrawlerOptions {
  stagehand: Stagehand
  collector: MetricsCollector
  email?: string
  maxSteps?: number
  stepTimeoutMs?: number
}

type StepResult =
  | { stop: true; stoppedReason: StoppedReason }
  | { stop: false; stepData: StepData }
  | { timeout: true }

export class FlowCrawler {
  private stagehand: Stagehand
  private collector: MetricsCollector
  private email: string | undefined
  private maxSteps: number
  private stepTimeoutMs: number

  constructor(options: FlowCrawlerOptions) {
    this.stagehand = options.stagehand
    this.collector = options.collector
    this.email = options.email
    this.maxSteps = options.maxSteps ?? 20
    this.stepTimeoutMs = options.stepTimeoutMs ?? 30_000
  }

  async crawl(url: string): Promise<{ steps: StepData[]; stoppedReason: StoppedReason }> {
    const steps: StepData[] = []
    let stoppedReason: StoppedReason = 'max_steps_reached'

    try {
      await this.stagehand.page.addInitScript(() => {
        ;(window as any).__clickCount = 0
        document.addEventListener('click', () => (window as any).__clickCount++, true)
      })
      await this.stagehand.page.goto(url)

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
      }
    } catch {
      stoppedReason = 'error'
    }

    return { steps, stoppedReason }
  }

  private async executeStep(index: number): Promise<StepResult> {
    await this.collector.startStep()

    const classification = await (this.stagehand as any).extract({
      instruction: 'Classify this page in the context of a SaaS signup/onboarding flow.',
      schema: PageClassificationSchema,
    })

    const effectiveType: PageType =
      classification.confidence === 'low' ? 'unknown' : classification.pageType

    if (classification.isTerminal || effectiveType === 'unknown') {
      return { stop: true, stoppedReason: this.resolveStoppedReason(effectiveType) }
    }

    await this.dispatch(effectiveType)

    const metrics = await this.collector.endStep()
    const stepData: StepData = {
      stepIndex: index,
      pageType: effectiveType,
      url: this.stagehand.page.url(),
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
      payment: 'payment_wall',
      unknown: 'unclassifiable_page',
    }
    return map[pageType] ?? 'unclassifiable_page'
  }

  private async dispatch(pageType: PageType): Promise<void> {
    switch (pageType) {
      case 'landing':
        await this.handleLanding()
        break
      case 'signup_form':
        await this.handleSignupForm()
        break
      case 'onboarding_step':
      case 'onboarding_survey':
      case 'workspace_setup':
        await (this.stagehand as any).act({
          action: 'Click the next, continue, or skip button to advance.',
        })
        break
      case 'plan_selection':
        await (this.stagehand as any).act({
          action: 'Select the free plan if one is available, otherwise click continue or skip.',
        })
        break
    }
  }

  private async handleLanding(): Promise<void> {
    const cta = await (this.stagehand as any).extract({
      instruction: 'Find the signup or get started call-to-action link or button.',
      schema: CtaSchema,
    })

    if (cta.signupUrl) {
      await this.stagehand.page.goto(cta.signupUrl)
    } else {
      await (this.stagehand as any).act({
        action: 'Click the sign up or get started button.',
      })
    }
  }

  private async handleSignupForm(): Promise<void> {
    const email = this.email ?? `bench-${Date.now()}@example.com`
    await (this.stagehand as any).act({
      action: `Fill in the signup form. Use name "${DUMMY_USER.name}", email "${email}", company "${DUMMY_USER.company}", password "${DUMMY_USER.password}". Only fill fields that are present on the form. Then submit the form.`,
    })
  }
}
