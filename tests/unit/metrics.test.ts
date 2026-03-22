import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { chromium } from 'playwright'
import type { Browser, BrowserContext, Page } from 'playwright'
import { MetricsCollector } from '../../src/metrics/MetricsCollector'

let browser: Browser
let context: BrowserContext
let page: Page

beforeAll(async () => {
  browser = await chromium.launch()
})

afterAll(async () => {
  await browser.close()
})

beforeEach(async () => {
  context = await browser.newContext()
  page = await context.newPage()
})

afterEach(async () => {
  await context.close()
})

async function setupPage(html: string) {
  await page.setContent(html)
  // Simulate the click counter that FlowCrawler injects via addInitScript
  await page.evaluate(() => {
    (window as any).__clickCount = 0
    document.addEventListener('click', () => (window as any).__clickCount++, true)
  })
}

describe('MetricsCollector — click counting', () => {
  it('counts zero clicks when nothing is clicked', async () => {
    await setupPage('<button id="btn">Click me</button>')
    const collector = new MetricsCollector(page)
    await collector.startStep()
    const metrics = await collector.endStep()
    expect(metrics.clickCount).toBe(0)
  })

  it('counts clicks that happen between startStep and endStep', async () => {
    await setupPage('<button id="btn">Click me</button>')
    const collector = new MetricsCollector(page)
    await collector.startStep()
    await page.click('#btn')
    await page.click('#btn')
    const metrics = await collector.endStep()
    expect(metrics.clickCount).toBe(2)
  })
})

describe('MetricsCollector — form fields', () => {
  it('extracts form fields with labels', async () => {
    await setupPage(`
      <form>
        <label for="email">Email</label>
        <input id="email" type="email" required>
        <label for="pw">Password</label>
        <input id="pw" type="password">
      </form>
    `)
    const collector = new MetricsCollector(page)
    await collector.startStep()
    const metrics = await collector.endStep()
    expect(metrics.formFields).toHaveLength(2)
    expect(metrics.formFields[0]).toMatchObject({ label: 'Email', type: 'email', required: true })
    expect(metrics.formFields[1]).toMatchObject({ label: 'Password', type: 'password', required: false })
  })

  it('falls back to aria-label when no <label> element', async () => {
    await setupPage('<input type="text" aria-label="Full name">')
    const collector = new MetricsCollector(page)
    await collector.startStep()
    const metrics = await collector.endStep()
    expect(metrics.formFields[0].label).toBe('Full name')
  })

  it('falls back to placeholder when no label or aria-label', async () => {
    await setupPage('<input type="text" placeholder="Enter your name">')
    const collector = new MetricsCollector(page)
    await collector.startStep()
    const metrics = await collector.endStep()
    expect(metrics.formFields[0].label).toBe('Enter your name')
  })

  it('returns empty array when no form fields', async () => {
    await setupPage('<p>No form here</p>')
    const collector = new MetricsCollector(page)
    await collector.startStep()
    const metrics = await collector.endStep()
    expect(metrics.formFields).toEqual([])
  })
})

describe('MetricsCollector — OAuth providers', () => {
  it('detects Google and GitHub OAuth buttons', async () => {
    await setupPage(`
      <button>Continue with Google</button>
      <button>Sign in with GitHub</button>
      <button>Submit</button>
    `)
    const collector = new MetricsCollector(page)
    await collector.startStep()
    const metrics = await collector.endStep()
    expect(metrics.oauthProviders).toContain('google')
    expect(metrics.oauthProviders).toContain('github')
    expect(metrics.oauthProviders).not.toContain('submit')
  })

  it('returns empty array when no OAuth buttons', async () => {
    await setupPage('<button>Continue</button>')
    const collector = new MetricsCollector(page)
    await collector.startStep()
    const metrics = await collector.endStep()
    expect(metrics.oauthProviders).toEqual([])
  })
})

describe('MetricsCollector — magic link detection', () => {
  it('detects magic link button', async () => {
    await setupPage('<button>Send Magic Link</button>')
    const collector = new MetricsCollector(page)
    await collector.startStep()
    const metrics = await collector.endStep()
    expect(metrics.hasMagicLink).toBe(true)
  })

  it('detects passwordless button', async () => {
    await setupPage('<a href="/passwordless">Passwordless sign in</a>')
    const collector = new MetricsCollector(page)
    await collector.startStep()
    const metrics = await collector.endStep()
    expect(metrics.hasMagicLink).toBe(true)
  })

  it('returns false when no magic link indicators', async () => {
    await setupPage('<button>Sign in with password</button>')
    const collector = new MetricsCollector(page)
    await collector.startStep()
    const metrics = await collector.endStep()
    expect(metrics.hasMagicLink).toBe(false)
  })
})

describe('MetricsCollector — DOM counts', () => {
  it('counts interactive elements', async () => {
    await setupPage(`
      <button>A</button>
      <a href="#">B</a>
      <input type="text">
    `)
    const collector = new MetricsCollector(page)
    await collector.startStep()
    const metrics = await collector.endStep()
    expect(metrics.interactiveElements).toBeGreaterThanOrEqual(3)
  })

  it('counts DOM nodes', async () => {
    await setupPage('<div><p>Hello</p></div>')
    const collector = new MetricsCollector(page)
    await collector.startStep()
    const metrics = await collector.endStep()
    expect(metrics.domNodeCount).toBeGreaterThan(0)
  })
})

describe('MetricsCollector — step duration', () => {
  it('stepDurationMs is a positive number', async () => {
    await setupPage('<p>Hello</p>')
    const collector = new MetricsCollector(page)
    await collector.startStep()
    const metrics = await collector.endStep()
    expect(metrics.stepDurationMs).toBeGreaterThan(0)
  })
})

describe('MetricsCollector — page load time', () => {
  it('returns null when setContent is used (no new navigation)', async () => {
    await setupPage('<p>Hello</p>')
    const collector = new MetricsCollector(page)
    await collector.startStep()
    const metrics = await collector.endStep()
    expect(metrics.pageLoadMs).toBeNull()
  })

  it('returns a positive number after a real navigation', async () => {
    await page.goto('data:text/html,<p>Hello</p>')
    await page.evaluate(() => {
      (window as any).__clickCount = 0
      document.addEventListener('click', () => (window as any).__clickCount++, true)
    })
    const collector = new MetricsCollector(page)
    await collector.startStep()
    // Navigate to a new page
    await page.goto('data:text/html,<p>World</p>')
    const metrics = await collector.endStep()
    expect(metrics.pageLoadMs).not.toBeNull()
    expect(metrics.pageLoadMs).toBeGreaterThanOrEqual(0)
  })
})
