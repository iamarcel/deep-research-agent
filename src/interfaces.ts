import { ChatMessage } from "./schema.js";
import { URL } from "node:url";

export interface ILLMService {
  chatCompletion(messages: ChatMessage[], model?: string): Promise<string>;
  // Consider adding helper methods that wrap chatCompletion and attempt Zod parsing
  // e.g., generateStructured<T extends z.ZodTypeAny>(messages: ChatMessage[], schema: T, model?: string): Promise<z.infer<T> | null>;
}

export interface ISearchService {
  search(query: string): Promise<URL[]>;
}

export interface IWebScraperService {
  fetchText(url: URL): Promise<string | null>; // Return null if fetch fails gracefully
}

export interface ResearchServices {
  llm: ILLMService;
  search: ISearchService;
  scraper: IWebScraperService;
}
