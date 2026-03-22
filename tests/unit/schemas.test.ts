import { describe, it, expect } from 'vitest'
import { PageTypeSchema, PageClassificationSchema } from '../../src/schemas/page'
import { FormFieldSchema, StepMetricsSchema, StepDataSchema } from '../../src/schemas/metrics'
import { StoppedReasonSchema, CrawlReportSchema } from '../../src/schemas/report'

describe('PageTypeSchema', () => {
  it('accepts all valid page types', () => {
    const types = [
      'landing', 'signup_form', 'login_form', 'oauth_consent',
      'email_verification', 'onboarding_step', 'onboarding_survey',
      'workspace_setup', 'plan_selection', 'payment', 'dashboard', 'unknown'
    ]
    types.forEach(t => expect(() => PageTypeSchema.parse(t)).not.toThrow())
  })

  it('rejects unknown page types', () => {
    expect(() => PageTypeSchema.parse('checkout')).toThrow()
  })
})

describe('PageClassificationSchema', () => {
  it('accepts a valid classification', () => {
    const result = PageClassificationSchema.parse({
      pageType: 'landing',
      isTerminal: false,
      confidence: 'high',
      reason: 'Landing page with hero section'
    })
    expect(result.pageType).toBe('landing')
  })

  it('rejects missing fields', () => {
    expect(() => PageClassificationSchema.parse({ pageType: 'landing' })).toThrow()
  })

  it('rejects invalid confidence value', () => {
    expect(() => PageClassificationSchema.parse({
      pageType: 'landing', isTerminal: false, confidence: 'maybe', reason: 'test'
    })).toThrow()
  })
})

describe('FormFieldSchema', () => {
  it('rejects non-boolean required field', () => {
    expect(() => FormFieldSchema.parse({ label: 'Email', type: 'email', required: 'yes' })).toThrow()
  })
})

describe('StepMetricsSchema', () => {
  const validMetrics = {
    clickCount: 2,
    formFields: [],
    oauthProviders: ['google'],
    hasMagicLink: false,
    pageLoadMs: 342.5,
    stepDurationMs: 1200,
    a11yViolations: 0,
    a11yCritical: 0,
    a11ySerious: 0,
    interactiveElements: 5,
    domNodeCount: 120
  }

  it('accepts valid metrics', () => {
    expect(() => StepMetricsSchema.parse(validMetrics)).not.toThrow()
  })

  it('accepts null pageLoadMs', () => {
    expect(() => StepMetricsSchema.parse({ ...validMetrics, pageLoadMs: null })).not.toThrow()
  })

  it('rejects missing fields', () => {
    const { clickCount: _, ...rest } = validMetrics
    expect(() => StepMetricsSchema.parse(rest)).toThrow()
  })
})

describe('StepDataSchema', () => {
  it('accepts a valid step', () => {
    const step = {
      stepIndex: 0,
      pageType: 'landing',
      url: 'https://example.com',
      metrics: {
        clickCount: 1, formFields: [], oauthProviders: [], hasMagicLink: false,
        pageLoadMs: null, stepDurationMs: 800, a11yViolations: 0,
        a11yCritical: 0, a11ySerious: 0, interactiveElements: 3, domNodeCount: 50
      }
    }
    expect(() => StepDataSchema.parse(step)).not.toThrow()
  })

  it('rejects invalid pageType value', () => {
    expect(() => StepDataSchema.parse({
      stepIndex: 0,
      pageType: 'checkout',
      url: 'https://example.com',
      metrics: {
        clickCount: 1, formFields: [], oauthProviders: [], hasMagicLink: false,
        pageLoadMs: null, stepDurationMs: 800, a11yViolations: 0,
        a11yCritical: 0, a11ySerious: 0, interactiveElements: 3, domNodeCount: 50
      }
    })).toThrow()
  })
})

describe('StoppedReasonSchema', () => {
  const reasons = [
    'dashboard_reached', 'email_verification_wall', 'oauth_wall', 'payment_wall',
    'captcha_detected', 'login_redirect', 'max_steps_reached', 'unclassifiable_page', 'error'
  ]

  it('accepts all valid stopped reasons', () => {
    reasons.forEach(r => expect(() => StoppedReasonSchema.parse(r)).not.toThrow())
  })

  it('rejects unknown reason', () => {
    expect(() => StoppedReasonSchema.parse('timeout')).toThrow()
  })
})

describe('CrawlReportSchema', () => {
  const validReport = {
    url: 'https://airtable.com',
    crawledAt: new Date().toISOString(),
    completedSuccessfully: false,
    stoppedReason: 'email_verification_wall',
    steps: [],
    summary: {
      totalSteps: 0, totalClicks: 0, totalFormFields: 0, totalTimeMs: 0,
      oauthProviders: [], hasSso: false, hasMagicLink: false,
      requiresEmailVerification: false, requiresPayment: false,
      requiresOnboardingSurvey: false, totalA11yViolations: 0, flowPath: []
    }
  }

  it('accepts a valid report with empty steps', () => {
    expect(() => CrawlReportSchema.parse(validReport)).not.toThrow()
  })

  it('accepts optional category and emailUsed', () => {
    expect(() => CrawlReportSchema.parse({
      ...validReport,
      category: 'fintech',
      emailUsed: 'test@example.com'
    })).not.toThrow()
  })

  it('rejects invalid datetime for crawledAt', () => {
    expect(() => CrawlReportSchema.parse({
      ...validReport,
      crawledAt: '1742563800000'  // epoch ms string, not ISO — should fail
    })).toThrow()
  })
})
