import { z } from 'zod'
import { PageTypeSchema } from './page'

export const FormFieldSchema = z.object({
  label: z.string(),
  type: z.string(),
  required: z.boolean()
})

export type FormField = z.infer<typeof FormFieldSchema>

export const StepMetricsSchema = z.object({
  clickCount: z.number(),
  formFields: z.array(FormFieldSchema),
  oauthProviders: z.array(z.string()),
  hasMagicLink: z.boolean(),
  pageLoadMs: z.number().nullable(),
  stepDurationMs: z.number(),
  a11yViolations: z.number(),
  a11yCritical: z.number(),
  a11ySerious: z.number(),
  interactiveElements: z.number(),
  domNodeCount: z.number()
})

export type StepMetrics = z.infer<typeof StepMetricsSchema>

export const StepDataSchema = z.object({
  stepIndex: z.number(),
  pageType: PageTypeSchema,
  url: z.string(),
  metrics: StepMetricsSchema
})

export type StepData = z.infer<typeof StepDataSchema>
