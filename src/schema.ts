import { z } from "zod";

// Basic Types
const UrlSchema = z
  .string()
  .url()
  .transform((str) => new URL(str));
const NonEmptyStringSchema = z.string().min(1);

// LLM Schemas
export const ChatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

// Expected structured LLM output schemas
export const SearchQueryListSchema = z.array(NonEmptyStringSchema).max(4); // Python: ['query1', 'query2']
export const UsefulnessDecisionSchema = z.enum(["Yes", "No"]); // Python: "Yes" or "No"

// Search Service Schema
export const SearchResultSchema = z.array(UrlSchema);

// Agent Schemas
export const ResearchTaskInputSchema = z.object({
  userQuery: NonEmptyStringSchema,
  iterationLimit: z.number().int().positive().optional().default(3),
  // We'll pass service instances directly, but config could go here
});
export type ResearchTaskInput = z.infer<typeof ResearchTaskInputSchema>;

export const ResearchReportSchema = z.object({
  report: z.string(),
  usedQueries: z.array(NonEmptyStringSchema),
  usedSources: z.array(UrlSchema), // Could add more metadata
});
export type ResearchReport = z.infer<typeof ResearchReportSchema>;
