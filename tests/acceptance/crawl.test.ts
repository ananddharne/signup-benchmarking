import { describe, it, expect } from 'vitest'
import { CrawlRunner } from '../../src/crawler/CrawlRunner'
import { CrawlReportSchema, StoppedReasonSchema } from '../../src/schemas/report'

describe('Full crawl — Airtable signup flow', () => {
  it('produces a valid CrawlReport with at least one step', async () => {
    const runner = new CrawlRunner({
      email: 'bench-test@example.com',
      timeoutMs: 60_000,
    })

    const report = await runner.run('https://airtable.com', 'productivity')

    // Report must parse the Zod schema without throwing
    expect(() => CrawlReportSchema.parse(report)).not.toThrow()

    // Must have attempted at least one step
    expect(report.steps.length).toBeGreaterThan(0)

    // First step should be the landing page
    expect(report.summary.flowPath[0]).toBe('landing')

    // stoppedReason must be a known value
    expect(() => StoppedReasonSchema.parse(report.stoppedReason)).not.toThrow()

    // Summary fields must be non-negative numbers
    expect(report.summary.totalSteps).toBeGreaterThan(0)
    expect(report.summary.totalClicks).toBeGreaterThanOrEqual(0)
    expect(report.summary.totalTimeMs).toBeGreaterThan(0)

    // URL and crawledAt must be present and valid
    expect(report.url).toBe('https://airtable.com')
    expect(report.category).toBe('productivity')
    expect(new Date(report.crawledAt).getTime()).not.toBeNaN()
  }, 300_000)
})
