import { CrawlReportSchema } from '../schemas/report'
import type { CrawlReport, BuildMeta } from '../schemas/report'
import type { StepData } from '../schemas/metrics'

export class ReportBuilder {
  static build(steps: StepData[], meta: BuildMeta): CrawlReport {
    const totalClicks = steps.reduce((sum, s) => sum + s.metrics.clickCount, 0)
    const totalFormFields = steps.reduce((sum, s) => sum + s.metrics.formFields.length, 0)
    const totalTimeMs = steps.reduce((sum, s) => sum + s.metrics.stepDurationMs, 0)
    const totalA11yViolations = steps.reduce((sum, s) => sum + s.metrics.a11yViolations, 0)

    const allProviders = steps.flatMap(s => s.metrics.oauthProviders)
    const oauthProviders = [...new Set(allProviders)]

    const hasMagicLink = steps.some(s => s.metrics.hasMagicLink)
    const hasSso = oauthProviders.some(p => ['okta', 'saml'].includes(p))
    const requiresEmailVerification = meta.stoppedReason === 'email_verification_wall'
    const requiresPayment = meta.stoppedReason === 'payment_wall'
    const requiresOnboardingSurvey = steps.some(s => s.pageType === 'onboarding_survey')

    const flowPath = steps.map(s => s.pageType)
    const completedSuccessfully = meta.stoppedReason === 'dashboard_reached'

    const report: CrawlReport = {
      url: meta.url,
      category: meta.category,
      crawledAt: meta.crawledAt,
      completedSuccessfully,
      stoppedReason: meta.stoppedReason,
      steps,
      summary: {
        totalSteps: steps.length,
        totalClicks,
        totalFormFields,
        totalTimeMs,
        oauthProviders,
        hasSso,
        hasMagicLink,
        requiresEmailVerification,
        requiresPayment,
        requiresOnboardingSurvey,
        totalA11yViolations,
        flowPath,
      },
      emailUsed: meta.emailUsed,
    }

    return CrawlReportSchema.parse(report)
  }
}
