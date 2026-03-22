import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CrawlRunner } from './crawler/CrawlRunner'
import type { CrawlReport } from './schemas/report'

function getArg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i !== -1 ? args[i + 1] : undefined
}

function sanitizeUrl(url: string): string {
  return url
    .replace(/^https?:\/\//, '')
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
}

function writeReport(report: CrawlReport, category: string | undefined, url: string): void {
  const timestamp = Date.now()
  const sanitized = sanitizeUrl(url)
  const filename = category
    ? `${sanitizeUrl(category)}-${sanitized}-${timestamp}.json`
    : `${sanitized}-${timestamp}.json`
  const outPath = join('reports', filename)
  writeFileSync(outPath, JSON.stringify(report, null, 2))
  console.log(`Report written to ${outPath}`)
}

async function crawlAndWrite(runner: CrawlRunner, url: string, category?: string): Promise<void> {
  try {
    console.log(`Crawling: ${url}`)
    const report = await runner.run(url, category)
    writeReport(report, category, url)
  } catch (err) {
    console.error(`Failed to crawl ${url}:`, err)
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const url = getArg(args, '--url')
  const csvPath = getArg(args, '--csv')
  const email = getArg(args, '--email')

  if (!url && !csvPath) {
    console.error('Usage: crawl --url <url> [--email <email>]')
    console.error('       crawl --csv <path> [--email <email>]')
    process.exit(1)
  }

  mkdirSync('reports', { recursive: true })
  const runner = new CrawlRunner({ email })

  if (url) {
    await crawlAndWrite(runner, url)
  } else if (csvPath) {
    const csv = readFileSync(csvPath, 'utf-8')
    const lines = csv.trim().split('\n').slice(1) // skip header row
    for (const line of lines) {
      const [category, siteUrl] = line.split(',').map(s => s.trim())
      if (siteUrl) {
        await crawlAndWrite(runner, siteUrl, category)
      }
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
