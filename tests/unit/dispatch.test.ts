import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FlowCrawler } from '../../src/crawler/FlowCrawler'
import type { StepMetrics } from '../../src/schemas/metrics'
import type { PageClassification } from '../../src/schemas/page'

const mockMetrics: StepMetrics = {
  clickCount: 1, formFields: [], oauthProviders: [], hasMagicLink: false,
  pageLoadMs: null, stepDurationMs: 500, a11yViolations: 0,
  a11yCritical: 0, a11ySerious: 0, interactiveElements: 3, domNodeCount: 50
}

function makeClassification(overrides: Partial<PageClassification>): PageClassification {
  return {
    pageType: 'landing', isTerminal: false, confidence: 'high', reason: 'test',
    ...overrides,
  }
}

function makeMocks() {
  const mockPage = {
    url: vi.fn().mockReturnValue('https://example.com'),
    addInitScript: vi.fn().mockResolvedValue(undefined),
    goto: vi.fn().mockResolvedValue(undefined),
  }

  const mockStagehand = {
    page: mockPage,
    extract: vi.fn(),
    act: vi.fn().mockResolvedValue(undefined),
  }

  const mockCollector = {
    startStep: vi.fn().mockResolvedValue(undefined),
    endStep: vi.fn().mockResolvedValue(mockMetrics),
  }

  return { mockPage, mockStagehand, mockCollector }
}

describe('FlowCrawler — terminal page types', () => {
  it('stops with login_redirect on login_form', async () => {
    const { mockStagehand, mockCollector } = makeMocks()
    mockStagehand.extract.mockResolvedValueOnce(
      makeClassification({ pageType: 'login_form', isTerminal: true })
    )
    const crawler = new FlowCrawler({
      stagehand: mockStagehand as any,
      collector: mockCollector as any,
    })
    const { steps, stoppedReason } = await crawler.crawl('https://example.com')
    expect(stoppedReason).toBe('login_redirect')
    expect(steps).toHaveLength(0)
  })

  it('stops with oauth_wall on oauth_consent', async () => {
    const { mockStagehand, mockCollector } = makeMocks()
    mockStagehand.extract.mockResolvedValueOnce(
      makeClassification({ pageType: 'oauth_consent', isTerminal: true })
    )
    const crawler = new FlowCrawler({ stagehand: mockStagehand as any, collector: mockCollector as any })
    const { stoppedReason } = await crawler.crawl('https://example.com')
    expect(stoppedReason).toBe('oauth_wall')
  })

  it('stops with email_verification_wall on email_verification', async () => {
    const { mockStagehand, mockCollector } = makeMocks()
    mockStagehand.extract.mockResolvedValueOnce(
      makeClassification({ pageType: 'email_verification', isTerminal: true })
    )
    const crawler = new FlowCrawler({ stagehand: mockStagehand as any, collector: mockCollector as any })
    const { stoppedReason } = await crawler.crawl('https://example.com')
    expect(stoppedReason).toBe('email_verification_wall')
  })

  it('stops with payment_wall on payment', async () => {
    const { mockStagehand, mockCollector } = makeMocks()
    mockStagehand.extract.mockResolvedValueOnce(
      makeClassification({ pageType: 'payment', isTerminal: true })
    )
    const crawler = new FlowCrawler({ stagehand: mockStagehand as any, collector: mockCollector as any })
    const { stoppedReason } = await crawler.crawl('https://example.com')
    expect(stoppedReason).toBe('payment_wall')
  })

  it('stops with dashboard_reached on dashboard', async () => {
    const { mockStagehand, mockCollector } = makeMocks()
    mockStagehand.extract.mockResolvedValueOnce(
      makeClassification({ pageType: 'dashboard', isTerminal: true })
    )
    const crawler = new FlowCrawler({ stagehand: mockStagehand as any, collector: mockCollector as any })
    const { stoppedReason } = await crawler.crawl('https://example.com')
    expect(stoppedReason).toBe('dashboard_reached')
  })

  it('stops with unclassifiable_page on unknown', async () => {
    const { mockStagehand, mockCollector } = makeMocks()
    mockStagehand.extract.mockResolvedValueOnce(
      makeClassification({ pageType: 'unknown', isTerminal: true })
    )
    const crawler = new FlowCrawler({ stagehand: mockStagehand as any, collector: mockCollector as any })
    const { stoppedReason } = await crawler.crawl('https://example.com')
    expect(stoppedReason).toBe('unclassifiable_page')
  })
})

describe('FlowCrawler — confidence: low treated as unknown', () => {
  it('stops with unclassifiable_page when confidence is low', async () => {
    const { mockStagehand, mockCollector } = makeMocks()
    mockStagehand.extract.mockResolvedValueOnce(
      makeClassification({ pageType: 'signup_form', isTerminal: false, confidence: 'low' })
    )
    const crawler = new FlowCrawler({ stagehand: mockStagehand as any, collector: mockCollector as any })
    const { stoppedReason } = await crawler.crawl('https://example.com')
    expect(stoppedReason).toBe('unclassifiable_page')
  })
})

describe('FlowCrawler — non-terminal steps append to steps[]', () => {
  it('appends a StepData for landing page then stops on dashboard', async () => {
    const { mockStagehand, mockCollector, mockPage } = makeMocks()
    // First classification: landing (non-terminal)
    // extract() is called for both page classification AND the landing CTA detection
    mockStagehand.extract
      .mockResolvedValueOnce(makeClassification({ pageType: 'landing', isTerminal: false }))
      .mockResolvedValueOnce({ signupUrl: 'https://example.com/signup', signupText: 'Sign up' })
      // Second iteration: dashboard (terminal)
      .mockResolvedValueOnce(makeClassification({ pageType: 'dashboard', isTerminal: true }))

    mockPage.url.mockReturnValue('https://example.com/signup')

    const crawler = new FlowCrawler({ stagehand: mockStagehand as any, collector: mockCollector as any })
    const { steps, stoppedReason } = await crawler.crawl('https://example.com')

    expect(stoppedReason).toBe('dashboard_reached')
    expect(steps).toHaveLength(1)
    expect(steps[0].pageType).toBe('landing')
  })
})

describe('FlowCrawler — max steps', () => {
  it('stops with max_steps_reached after maxSteps non-terminal steps', async () => {
    const { mockStagehand, mockCollector } = makeMocks()
    // Always return a non-terminal onboarding_step
    mockStagehand.extract.mockResolvedValue(
      makeClassification({ pageType: 'onboarding_step', isTerminal: false })
    )
    const crawler = new FlowCrawler({
      stagehand: mockStagehand as any,
      collector: mockCollector as any,
      maxSteps: 3,
    })
    const { steps, stoppedReason } = await crawler.crawl('https://example.com')
    expect(stoppedReason).toBe('max_steps_reached')
    expect(steps).toHaveLength(3)
  })
})

describe('FlowCrawler — error handling', () => {
  it('returns partial report with stoppedReason=error when extract throws', async () => {
    const { mockStagehand, mockCollector } = makeMocks()
    mockStagehand.extract.mockRejectedValueOnce(new Error('Network error'))
    const crawler = new FlowCrawler({ stagehand: mockStagehand as any, collector: mockCollector as any })
    const { steps, stoppedReason } = await crawler.crawl('https://example.com')
    expect(stoppedReason).toBe('error')
    expect(steps).toHaveLength(0)
  })
})
