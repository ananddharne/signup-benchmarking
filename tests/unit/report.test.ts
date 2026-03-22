import { describe, it, expect } from 'vitest'
import { ReportBuilder } from '../../src/report/ReportBuilder'
import type { StepData } from '../../src/schemas/metrics'
import type { BuildMeta } from '../../src/schemas/report'
import { CrawlReportSchema } from '../../src/schemas/report'

const makeStep = (overrides: Partial<StepData> = {}): StepData => ({
  stepIndex: 0,
  pageType: 'landing',
  url: 'https://example.com',
  metrics: {
    clickCount: 2,
    formFields: [{ label: 'Email', type: 'email', required: true }],
    oauthProviders: ['google'],
    hasMagicLink: false,
    pageLoadMs: 300,
    stepDurationMs: 1000,
    a11yViolations: 1,
    a11yCritical: 0,
    a11ySerious: 1,
    interactiveElements: 5,
    domNodeCount: 100,
  },
  ...overrides,
})

const baseMeta: BuildMeta = {
  url: 'https://example.com',
  crawledAt: new Date().toISOString(),
  stoppedReason: 'email_verification_wall',
}

describe('ReportBuilder.build', () => {
  it('produces a Zod-valid report from empty steps', () => {
    const report = ReportBuilder.build([], baseMeta)
    expect(() => CrawlReportSchema.parse(report)).not.toThrow()
  })

  it('sets completedSuccessfully=false when stoppedReason is not dashboard_reached', () => {
    const report = ReportBuilder.build([], { ...baseMeta, stoppedReason: 'error' })
    expect(report.completedSuccessfully).toBe(false)
  })

  it('sets completedSuccessfully=true when stoppedReason is dashboard_reached', () => {
    const report = ReportBuilder.build([], { ...baseMeta, stoppedReason: 'dashboard_reached' })
    expect(report.completedSuccessfully).toBe(true)
  })

  it('defaults all summary fields to zero/false/empty for empty steps', () => {
    const report = ReportBuilder.build([], { ...baseMeta, stoppedReason: 'max_steps_reached' })
    expect(report.summary.totalSteps).toBe(0)
    expect(report.summary.totalClicks).toBe(0)
    expect(report.summary.totalFormFields).toBe(0)
    expect(report.summary.totalTimeMs).toBe(0)
    expect(report.summary.oauthProviders).toEqual([])
    expect(report.summary.hasSso).toBe(false)
    expect(report.summary.hasMagicLink).toBe(false)
    expect(report.summary.requiresEmailVerification).toBe(false)
    expect(report.summary.requiresPayment).toBe(false)
    expect(report.summary.requiresOnboardingSurvey).toBe(false)
    expect(report.summary.totalA11yViolations).toBe(0)
    expect(report.summary.flowPath).toEqual([])
  })

  it('aggregates clicks and form fields across steps', () => {
    const steps = [
      makeStep({ stepIndex: 0, metrics: { ...makeStep().metrics, clickCount: 2, formFields: [{ label: 'Email', type: 'email', required: true }] } }),
      makeStep({ stepIndex: 1, metrics: { ...makeStep().metrics, clickCount: 3, formFields: [{ label: 'Name', type: 'text', required: false }] } }),
    ]
    const report = ReportBuilder.build(steps, baseMeta)
    expect(report.summary.totalSteps).toBe(2)
    expect(report.summary.totalClicks).toBe(5)
    expect(report.summary.totalFormFields).toBe(2)
  })

  it('aggregates totalTimeMs as sum of stepDurationMs', () => {
    const steps = [
      makeStep({ metrics: { ...makeStep().metrics, stepDurationMs: 1000 } }),
      makeStep({ metrics: { ...makeStep().metrics, stepDurationMs: 2000 } }),
    ]
    const report = ReportBuilder.build(steps, baseMeta)
    expect(report.summary.totalTimeMs).toBe(3000)
  })

  it('deduplicates oauthProviders across steps', () => {
    const steps = [
      makeStep({ metrics: { ...makeStep().metrics, oauthProviders: ['google', 'github'] } }),
      makeStep({ metrics: { ...makeStep().metrics, oauthProviders: ['google', 'microsoft'] } }),
    ]
    const report = ReportBuilder.build(steps, baseMeta)
    expect(report.summary.oauthProviders.sort()).toEqual(['github', 'google', 'microsoft'])
  })

  it('sets hasMagicLink=true if any step detected it', () => {
    const steps = [
      makeStep({ metrics: { ...makeStep().metrics, hasMagicLink: false } }),
      makeStep({ metrics: { ...makeStep().metrics, hasMagicLink: true } }),
    ]
    const report = ReportBuilder.build(steps, baseMeta)
    expect(report.summary.hasMagicLink).toBe(true)
  })

  it('sets hasSso=true when okta or saml is in oauthProviders', () => {
    const steps = [
      makeStep({ metrics: { ...makeStep().metrics, oauthProviders: ['google', 'okta'] } }),
    ]
    const report = ReportBuilder.build(steps, baseMeta)
    expect(report.summary.hasSso).toBe(true)
  })

  it('sets hasSso=false when no SSO providers present', () => {
    const steps = [
      makeStep({ metrics: { ...makeStep().metrics, oauthProviders: ['google', 'github'] } }),
    ]
    const report = ReportBuilder.build(steps, baseMeta)
    expect(report.summary.hasSso).toBe(false)
  })

  it('sets requiresEmailVerification when stoppedReason is email_verification_wall', () => {
    const report = ReportBuilder.build([], { ...baseMeta, stoppedReason: 'email_verification_wall' })
    expect(report.summary.requiresEmailVerification).toBe(true)
  })

  it('sets requiresPayment when stoppedReason is payment_wall', () => {
    const report = ReportBuilder.build([], { ...baseMeta, stoppedReason: 'payment_wall' })
    expect(report.summary.requiresPayment).toBe(true)
  })

  it('sets requiresOnboardingSurvey when any step is onboarding_survey', () => {
    const steps = [
      makeStep({ pageType: 'landing' }),
      makeStep({ pageType: 'onboarding_survey' }),
    ]
    const report = ReportBuilder.build(steps, baseMeta)
    expect(report.summary.requiresOnboardingSurvey).toBe(true)
  })

  it('builds flowPath from step pageTypes in order', () => {
    const steps = [
      makeStep({ stepIndex: 0, pageType: 'landing' }),
      makeStep({ stepIndex: 1, pageType: 'signup_form' }),
      makeStep({ stepIndex: 2, pageType: 'onboarding_step' }),
    ]
    const report = ReportBuilder.build(steps, baseMeta)
    expect(report.summary.flowPath).toEqual(['landing', 'signup_form', 'onboarding_step'])
  })

  it('sums a11y violations across steps', () => {
    const steps = [
      makeStep({ metrics: { ...makeStep().metrics, a11yViolations: 2 } }),
      makeStep({ metrics: { ...makeStep().metrics, a11yViolations: 3 } }),
    ]
    const report = ReportBuilder.build(steps, baseMeta)
    expect(report.summary.totalA11yViolations).toBe(5)
  })

  it('includes category and emailUsed when provided', () => {
    const report = ReportBuilder.build([], {
      ...baseMeta, category: 'fintech', emailUsed: 'test@example.com'
    })
    expect(report.category).toBe('fintech')
    expect(report.emailUsed).toBe('test@example.com')
  })
})
