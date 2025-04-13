import dotenv from "dotenv";
import { z } from "zod";

// Load .env file variables into process.env
dotenv.config();

// Get your Jina AI API key for free: https://jina.ai/?sui=apikey
// Get your OpenAI API key: https://platform.openai.com/api-keys

const EnvSchema = z.object({
  OPENAI_BASEURL: z.string().url().default("https://api.openai.com/v1"),
  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),
  OPENAI_DEFAULT_MODEL: z.string().optional().default("gpt-4o-mini"),

  JINA_API_KEY: z.string().min(1, "JINA_API_KEY is required"),
  JINA_SEARCH_ENDPOINT: z.string().url().default("https://s.jina.ai/"),
  JINA_READER_ENDPOINT: z.string().url().default("https://r.jina.ai/"),
});

const parseResult = EnvSchema.safeParse(process.env);

if (!parseResult.success) {
  console.error(
    "❌ Invalid environment variables:",
    parseResult.error.flatten().fieldErrors,
  );
  throw new Error("Invalid environment variables");
}

export const config = Object.freeze(parseResult.data);

console.log("✅ Config loaded successfully", config);
