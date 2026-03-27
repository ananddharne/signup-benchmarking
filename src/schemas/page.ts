import { z } from 'zod'

export const PageTypeSchema = z.enum([
  'landing', 'signup_form', 'login_form', 'oauth_consent',
  'email_verification', 'captcha', 'onboarding_step', 'onboarding_survey',
  'workspace_setup', 'plan_selection', 'payment', 'dashboard', 'unknown'
])

export type PageType = z.infer<typeof PageTypeSchema>

export const PageClassificationSchema = z.object({
  pageType: PageTypeSchema,
  isTerminal: z.boolean(),
  confidence: z.enum(['high', 'medium', 'low']),
  reason: z.string()
})

export type PageClassification = z.infer<typeof PageClassificationSchema>
