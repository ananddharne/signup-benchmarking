import { Stagehand } from '@browserbasehq/stagehand'
import { chromium } from '@playwright/test'
import type { Browser } from '@playwright/test'
import { FlowCrawler } from './FlowCrawler'
import { MetricsCollector } from '../metrics/MetricsCollector'
import { ReportBuilder } from '../report/ReportBuilder'
import type { CrawlReport } from '../schemas/report'

const CDP_PORT = 9222

interface CrawlRunnerOptions {
  timeoutMs?: number
}

export class CrawlRunner {
  private options: Required<CrawlRunnerOptions>

  constructor(options: CrawlRunnerOptions = {}) {
    this.options = {
      timeoutMs: options.timeoutMs ?? 120_000,
    }
  }

  async run(url: string, category?: string): Promise<CrawlReport> {
    const now = new Date()

    const stagehand = new Stagehand({
      env: 'LOCAL',
      model: { modelName: 'anthropic/claude-sonnet-4-6', apiKey: process.env.ANTHROPIC_API_KEY },
      localBrowserLaunchOptions: { port: CDP_PORT },
      verbose: 1,
    })

    await stagehand.init()

    // Connect Playwright to the same Chrome instance for full DOM API access
    let playwrightBrowser: Browser | null = null
    playwrightBrowser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`)
    const pwContext = playwrightBrowser.contexts()[0]
    const page = pwContext.pages()[0]

    const stagehandPage = stagehand.context.pages()[0]
    const collector = new MetricsCollector(page)
    const crawler = new FlowCrawler({
      stagehand,
      page: stagehandPage as any,
      pwPage: page,
      collector,
      stepTimeoutMs: this.options.timeoutMs,
    })

    let steps: Awaited<ReturnType<FlowCrawler['crawl']>>['steps'] = []
    let stoppedReason: Awaited<ReturnType<FlowCrawler['crawl']>>['stoppedReason'] = 'error'

    try {
      const result = await crawler.crawl(url)
      steps = result.steps
      stoppedReason = result.stoppedReason
    } finally {
      await playwrightBrowser?.close()
      await stagehand.close()
    }

    return ReportBuilder.build(steps, {
      url,
      category,
      crawledAt: now.toISOString(),
      stoppedReason,
    })
  }
}
