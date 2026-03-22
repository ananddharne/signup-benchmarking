import { Stagehand } from '@browserbasehq/stagehand'
import { FlowCrawler } from './FlowCrawler'
import { MetricsCollector } from '../metrics/MetricsCollector'
import { ReportBuilder } from '../report/ReportBuilder'
import type { CrawlReport } from '../schemas/report'

interface CrawlRunnerOptions {
  email?: string
  timeoutMs?: number
}

export class CrawlRunner {
  private options: Required<CrawlRunnerOptions>

  constructor(options: CrawlRunnerOptions = {}) {
    this.options = {
      email: options.email ?? '',
      timeoutMs: options.timeoutMs ?? 30_000,
    }
  }

  async run(url: string, category?: string): Promise<CrawlReport> {
    const now = new Date()

    const stagehand = new Stagehand({
      env: 'LOCAL',
      modelName: 'claude-3-7-sonnet-latest',
      modelClientOptions: { apiKey: process.env.ANTHROPIC_API_KEY },
    })

    await stagehand.init()

    const collector = new MetricsCollector(stagehand.page)
    const crawler = new FlowCrawler({
      stagehand,
      collector,
      email: this.options.email || undefined,
      stepTimeoutMs: this.options.timeoutMs,
    })

    let steps: Awaited<ReturnType<FlowCrawler['crawl']>>['steps'] = []
    let stoppedReason: Awaited<ReturnType<FlowCrawler['crawl']>>['stoppedReason'] = 'error'

    try {
      const result = await crawler.crawl(url)
      steps = result.steps
      stoppedReason = result.stoppedReason
    } finally {
      await stagehand.close()
    }

    return ReportBuilder.build(steps, {
      url,
      category,
      crawledAt: now.toISOString(),
      emailUsed: this.options.email || undefined,
      stoppedReason,
    })
  }
}
