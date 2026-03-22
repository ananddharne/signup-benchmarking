import { z } from 'zod'
import { PageTypeSchema } from './page'
import { StepDataSchema } from './metrics'

export const StoppedReasonSchema = z.enum([
  'dashboard_reached',
  'email_verification_wall',
  'oauth_wall',
  'payment_wall',
  'captcha_detected',
  'login_redirect',
  'max_steps_reached',
  'unclassifiable_page',
  'error'
])

export type StoppedReason = z.infer<typeof StoppedReasonSchema>

export const CrawlReportSchema = z.object({
  url: z.string(),
  category: z.string().optional(),
  crawledAt: z.string().datetime(),
  completedSuccessfully: z.boolean(),
  stoppedReason: StoppedReasonSchema,
  steps: z.array(StepDataSchema),
  summary: z.object({
    totalSteps: z.number(),
    totalClicks: z.number(),
    totalFormFields: z.number(),
    totalTimeMs: z.number(),
    oauthProviders: z.array(z.string()),
    hasSso: z.boolean(),
    hasMagicLink: z.boolean(),
    requiresEmailVerification: z.boolean(),
    requiresPayment: z.boolean(),
    requiresOnboardingSurvey: z.boolean(),
    totalA11yViolations: z.number(),
    flowPath: z.array(PageTypeSchema)
  }),
  emailUsed: z.string().optional()
})

export type CrawlReport = z.infer<typeof CrawlReportSchema>

export interface BuildMeta {
  url: string
  category?: string
  crawledAt: string       // ISO 8601: new Date().toISOString()
  emailUsed?: string
  stoppedReason: StoppedReason
}
