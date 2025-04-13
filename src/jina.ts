import { config } from "./config.js";
import { ISearchService, IWebScraperService } from "./interfaces.js";
import pRetry, { AbortError } from "p-retry";
import { URL } from "url";
import { z } from "zod";

// --- Jina Search Service ---

// Zod schema for the expected response from Jina Search API (s.jina.ai)
const JinaSearchResponseSchema = z
  .object({
    code: z.number().optional(),
    status: z.number().optional(),
    data: z
      .array(
        z
          .object({
            url: z.string().url("Invalid URL received from Jina Search API"),
          })
          .passthrough(),
      )
      .optional()
      .default([]),
  })
  .passthrough();

export class JinaSearchService implements ISearchService {
  private apiKey: string;
  private endpoint: string;
  private commonHeaders: Record<string, string>;

  constructor() {
    if (!config.JINA_API_KEY) {
      throw new Error("JINA_API_KEY is not configured.");
    }
    this.apiKey = config.JINA_API_KEY;
    this.endpoint = config.JINA_SEARCH_ENDPOINT;
    this.commonHeaders = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    console.log(
      `[JinaSearchService] Initialized for endpoint: ${this.endpoint}`,
    );
  }

  async search(query: string): Promise<URL[]> {
    if (!query || query.trim().length === 0) {
      console.warn("[JinaSearchService] Received empty search query.");
      return [];
    }

    const payload = JSON.stringify({ q: query });

    const operation = async (): Promise<URL[]> => {
      console.log(
        `[JinaSearchService] Performing search for query: "${query}"`,
      );
      let response: Response;
      try {
        response = await fetch(this.endpoint, {
          method: "POST",
          headers: this.commonHeaders,
          body: payload,
          // Consider adding signal for timeout if needed: AbortController
        });
      } catch (error: unknown) {
        // Network errors or other fetch-related issues
        console.error(
          `[JinaSearchService] Fetch error calling Jina Search API for query "${query}":`,
          error,
        );
        // Rethrow network errors for p-retry
        throw error;
      }

      // Check for non-2xx status codes
      if (!response.ok) {
        const errorBody = await response
          .text()
          .catch(() => "Could not read error body");
        console.error(
          `[JinaSearchService] Jina Search API Error ${response.status} for query "${query}": ${errorBody}`,
        );
        // Retry on 5xx errors or potential rate limits (429)
        if (response.status === 429 || response.status >= 500) {
          // Throw an error that p-retry will catch
          throw new Error(`Jina Search API Error ${response.status}`);
        } else {
          // Don't retry on other client errors (4xx)
          throw new AbortError(
            `Jina Search API Client Error: ${response.status} ${response.statusText}`,
          );
        }
      }

      // Parse and validate the successful JSON response
      try {
        const responseData = await response.json();
        const validation =
          await JinaSearchResponseSchema.safeParseAsync(responseData);

        if (!validation.success) {
          console.warn(
            `[JinaSearchService] Invalid response structure received from Jina Search API for query "${query}":`,
            validation.error.flatten(),
          );
          // Don't retry on validation errors, throw specific error
          throw new AbortError(
            `Invalid response structure from Jina Search API.`,
          );
        }

        // Extract valid URLs
        const urls = validation.data.data
          .map((item) => {
            try {
              return new URL(item.url);
              // eslint-disable-next-line @typescript-eslint/no-unused-vars
            } catch (e) {
              console.warn(
                `[JinaSearchService] Skipping invalid URL format from Jina Search API: ${item.url}`,
              );
              return null;
            }
          })
          .filter((url): url is URL => url !== null);

        console.log(
          `[JinaSearchService] Found ${urls.length} results for query: "${query}"`,
        );
        return urls;
      } catch (jsonError: unknown) {
        console.error(
          `[JinaSearchService] Error parsing JSON response from Jina Search API for query "${query}":`,
          jsonError,
        );
        // Don't retry if JSON parsing fails on a successful response
        throw new AbortError(
          `Failed to parse JSON response from Jina Search API.`,
        );
      }
    };

    try {
      return await pRetry(operation, {
        retries: 3,
        minTimeout: 2000,
        factor: 2,
        onFailedAttempt: (error) => {
          console.warn(
            `[JinaSearchService] Attempt ${error.attemptNumber} failed for query "${query}". Retrying in ${error.retriesLeft} attempts... Error: ${error.message}`,
          );
        },
      });
    } catch (finalError) {
      // Log AbortErrors differently if needed, but ultimately return []
      if (finalError instanceof AbortError) {
        console.error(
          `[JinaSearchService] Search aborted for query "${query}": ${finalError.message}`,
        );
      } else {
        console.error(
          `[JinaSearchService] Failed Jina search for query "${query}" after retries:`,
          finalError,
        );
      }
      return []; // Return empty array on final failure
    }
  }
}

// --- Jina Reader Service ---

// Zod schema for the expected response from Jina Reader API (r.jina.ai)
const JinaReaderResponseSchema = z
  .object({
    code: z.number().optional(),
    status: z.number().optional(),
    data: z
      .object({
        content: z.string(),
      })
      .passthrough(),
  })
  .passthrough();

export class JinaReaderService implements IWebScraperService {
  private apiKey: string;
  private endpoint: string;
  private readerHeaders: Record<string, string>;

  constructor() {
    if (!config.JINA_API_KEY) {
      throw new Error("JINA_API_KEY is not configured.");
    }
    this.apiKey = config.JINA_API_KEY;
    this.endpoint = config.JINA_READER_ENDPOINT;
    this.readerHeaders = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Return-Format": "markdown",
      // 'X-Timeout': '30', // Optional: Example timeout
    };
    console.log(
      `[JinaReaderService] Initialized for endpoint: ${this.endpoint}`,
    );
  }

  async fetchText(url: URL): Promise<string | null> {
    const urlString = url.toString();
    const payload = JSON.stringify({ url: urlString });

    const operation = async (): Promise<string | null> => {
      console.log(`[JinaReaderService] Fetching text from URL: ${urlString}`);
      let response: Response;
      try {
        response = await fetch(this.endpoint, {
          method: "POST",
          headers: this.readerHeaders,
          body: payload,
          // Consider adding signal for timeout if needed: AbortController
        });
      } catch (error: unknown) {
        console.error(
          `[JinaReaderService] Fetch error calling Jina Reader API for URL "${urlString}":`,
          error,
        );
        // Rethrow network errors for p-retry
        throw error;
      }

      // Check for non-2xx status codes
      if (!response.ok) {
        const errorBody = await response
          .text()
          .catch(() => "Could not read error body");
        console.error(
          `[JinaReaderService] Jina Reader API Error ${response.status} for URL "${urlString}": ${errorBody}`,
        );

        // Retry on 5xx errors or potential rate limits (429)
        if (response.status === 429 || response.status >= 500) {
          throw new Error(`Jina Reader API Error ${response.status}`);
        } else {
          // Don't retry on other client errors (4xx). Return null as fetch failed non-transiently.
          console.warn(
            `[JinaReaderService] Non-retryable client error ${response.status} for URL ${urlString}. Returning null.`,
          );
          // Signal not to retry and that the outcome is null
          throw new AbortError("Non-retryable client error");
        }
      }

      // Parse and validate the successful JSON response
      try {
        const responseData = await response.json();
        const validation =
          await JinaReaderResponseSchema.safeParseAsync(responseData);

        if (!validation.success) {
          console.warn(
            `[JinaReaderService] Invalid response structure received from Jina Reader API for URL "${urlString}":`,
            validation.error.flatten(),
            responseData,
          );
          // Don't retry, indicates an API contract issue or unexpected response
          throw new AbortError(
            `Invalid response structure from Jina Reader API.`,
          );
        }

        // Check if content exists and is a non-empty string
        const content = validation.data.data.content;
        if (typeof content === "string" && content.trim().length > 0) {
          console.log(
            `[JinaReaderService] Successfully fetched text from ${urlString} (Length: ${content.length})`,
          );
          return content;
        } else {
          console.warn(
            `[JinaReaderService] Jina Reader API returned empty or missing content for URL "${urlString}". Returning null.`,
          );
          // Successful request but no usable content, don't retry.
          throw new AbortError("Empty or missing content");
        }
      } catch (jsonError: unknown) {
        // Handle AbortErrors from validation/content check above
        if (jsonError instanceof AbortError) {
          throw jsonError; // Propagate AbortError
        }
        // Handle actual JSON parsing errors
        console.error(
          `[JinaReaderService] Error parsing JSON response from Jina Reader API for URL "${urlString}":`,
          jsonError,
        );
        // Don't retry if JSON parsing fails on a successful response
        throw new AbortError(
          `Failed to parse JSON response from Jina Reader API.`,
        );
      }
    };

    try {
      return await pRetry(operation, {
        retries: 3,
        minTimeout: 1000,
        factor: 2,
        onFailedAttempt: (error) => {
          // Don't log retry attempts for AbortErrors
          if (!(error instanceof AbortError)) {
            console.warn(
              `[JinaReaderService] Attempt ${error.attemptNumber} failed for URL "${urlString}". Retrying in ${error.retriesLeft} attempts... Error: ${error.message}`,
            );
          }
        },
      });
    } catch (finalError) {
      // If the final error is an AbortError triggered by non-retryable conditions (client error, validation fail, empty content), return null
      if (finalError instanceof AbortError) {
        console.log(
          `[JinaReaderService] Fetch aborted for URL "${urlString}": ${finalError.message}. Returning null.`,
        );
        return null;
      }
      // Otherwise, it's a failure after retries
      console.error(
        `[JinaReaderService] Failed Jina reader fetch for URL "${urlString}" after retries:`,
        finalError,
      );
      return null; // Return null on final failure after retries
    }
  }
}
