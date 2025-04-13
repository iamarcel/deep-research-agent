import {
  ILLMService,
  IWebScraperService,
  ResearchServices,
} from "./interfaces.js";
import { PROMPTS } from "./prompts.js";
import {
  ResearchTaskInput,
  ResearchReport,
  ResearchTaskInputSchema,
  SearchQueryListSchema,
  ResearchReportSchema,
} from "./schema.js";
import { URL } from "node:url";
import { z } from "zod";

// Helper to safely parse JSON array from LLM
async function parseJsonArrayResponse<T extends z.ZodTypeAny>(
  llmResponse: string,
  schema: T,
): Promise<z.infer<T> | null> {
  try {
    // Try to find JSON array within potential markdown code blocks or surrounding text
    const jsonMatch = llmResponse.match(
      /```(?:json)?\s*([\s\S]*?)\s*```|(\[.*\])/,
    );
    const jsonString = jsonMatch ? jsonMatch[1] || jsonMatch[2] : llmResponse;

    if (!jsonString) return null; // No array-like structure found

    const parsed = JSON.parse(jsonString.trim());
    const validation = await schema.safeParseAsync(parsed);
    if (validation.success) {
      return validation.data;
    } else {
      console.warn(
        `Zod validation failed for LLM JSON array response: ${validation.error.message}. Raw response: ${llmResponse}`,
      );
      return null;
    }
  } catch (error) {
    console.warn(
      `Error parsing LLM JSON array response: ${error instanceof Error ? error.message : String(error)}. Raw response: ${llmResponse}`,
    );
    return null;
  }
}

async function processLink(
  link: URL,
  searchQuery: string, // The query that found this link
  userQuery: string,
  services: { llm: ILLMService; scraper: IWebScraperService },
): Promise<{ context: string; source: URL } | null> {
  console.log(`[ProcessLink] Fetching: ${link.toString()}`);
  const pageText = await services.scraper.fetchText(link);
  if (!pageText) {
    console.log(
      `[ProcessLink] Failed to fetch or empty content for: ${link.toString()}`,
    );
    return null;
  }

  console.log(`[ProcessLink] Evaluating usefulness: ${link.toString()}`);
  const usefulnessPrompt = PROMPTS.isPageUseful(userQuery, pageText);
  const usefulnessResponse = await services.llm.chatCompletion([
    {
      role: "system",
      content:
        'You are a strict and concise evaluator. Respond only "Yes" or "No".',
    },
    { role: "user", content: usefulnessPrompt },
  ]);

  // Robust check for "Yes"
  const isUseful = usefulnessResponse.trim().toLowerCase().startsWith("yes");
  console.log(
    `[ProcessLink] Usefulness for ${link.toString()}: ${isUseful ? "Yes" : "No"}`,
  );

  if (isUseful) {
    console.log(`[ProcessLink] Extracting context: ${link.toString()}`);
    const extractPrompt = PROMPTS.extractContext(
      userQuery,
      searchQuery,
      pageText,
    );
    const context = await services.llm.chatCompletion([
      {
        role: "system",
        content: "You extract relevant information concisely.",
      },
      { role: "user", content: extractPrompt },
    ]);

    if (context && context.trim().length > 0) {
      console.log(
        `[ProcessLink] Extracted context from ${link.toString()} (first 100 chars): ${context.slice(0, 100)}...`,
      );
      return { context: context.trim(), source: link };
    } else {
      console.log(
        `[ProcessLink] No context extracted from presumably useful page: ${link.toString()}`,
      );
    }
  }
  return null;
}

// Define a progress update interface
export interface ResearchProgress {
  stage: string;
  message: string;
  progress?: number; // optional percentage complete (0-100)
  detail?: Record<string, unknown>; // optional detailed information
}

// ============================
// Main Exported Function
// ============================

/**
 * Runs the deep research process.
 *
 * @param input - The research task details (query, limits).
 * @param services - Instances of the required external services.
 * @returns A generator that yields progress updates and resolves to the final research report.
 * @throws Error if critical steps fail (e.g., initial query generation).
 */
export async function* runResearchTask(
  input: ResearchTaskInput,
  services: ResearchServices,
): AsyncGenerator<ResearchProgress, ResearchReport, unknown> {
  const validatedInput = ResearchTaskInputSchema.parse(input); // Validate input
  const { userQuery, iterationLimit } = validatedInput;

  const aggregatedContexts: string[] = [];
  const allUsedSearchQueries: string[] = [];
  const allUsedSources: Set<URL> = new Set(); // Track unique sources used for context

  console.log(`[Agent] Starting research for query: "${userQuery}"`);
  yield {
    stage: "init",
    message: "Starting research process",
    detail: { query: userQuery },
  };

  // ----- 1. Generate Initial Search Queries -----
  console.log("[Agent] Generating initial search queries...");
  yield {
    stage: "queries",
    message: "Generating initial search queries",
  };

  const initialQueriesPrompt = PROMPTS.generateInitialQueries(userQuery);
  const initialQueriesResponse = await services.llm.chatCompletion([
    {
      role: "system",
      content: "You generate search queries as a JSON array of strings.",
    },
    { role: "user", content: initialQueriesPrompt },
  ]);
  let currentSearchQueries = await parseJsonArrayResponse(
    initialQueriesResponse,
    SearchQueryListSchema,
  );

  if (!currentSearchQueries || currentSearchQueries.length === 0) {
    console.error(
      "[Agent] Failed to generate valid initial search queries from LLM.",
      initialQueriesResponse,
    );
    throw new Error("Failed to generate initial search queries.");
  }
  allUsedSearchQueries.push(...currentSearchQueries);
  console.log(
    `[Agent] Initial queries: ${JSON.stringify(currentSearchQueries)}`,
  );

  yield {
    stage: "queries",
    message: "Generated initial search queries",
    detail: { queries: currentSearchQueries },
  };

  // ----- 2. Iterative Research Loop -----
  for (let iteration = 0; iteration < iterationLimit; iteration++) {
    console.log(
      `\n[Agent] === Iteration ${iteration + 1} / ${iterationLimit} ===`,
    );
    yield {
      stage: "iteration",
      message: `Starting research iteration ${iteration + 1}/${iterationLimit}`,
      progress: Math.round((iteration / iterationLimit) * 100),
    };

    if (!currentSearchQueries || currentSearchQueries.length === 0) {
      console.log("[Agent] No more queries to process in this iteration path.");
      break;
    }

    // --- Perform Search Concurrently ---
    console.log(
      `[Agent] Performing search for ${currentSearchQueries.length} queries...`,
    );
    yield {
      stage: "search",
      message: `Searching for ${currentSearchQueries.length} queries`,
      detail: { queries: currentSearchQueries },
    };

    const searchPromises = currentSearchQueries.map(async (query) => ({
      query,
      results: await services.search.search(query),
    }));
    const searchResults = await Promise.all(searchPromises);

    // --- Aggregate & Deduplicate Links ---
    const linksToProcess = new Map<string, string>(); // Map<URL string, search query>
    searchResults.forEach(({ query, results }) => {
      results.forEach((url) => {
        // Only add if not already present to avoid redundant processing within iteration
        if (!linksToProcess.has(url.toString())) {
          linksToProcess.set(url.toString(), query);
        }
      });
    });

    if (linksToProcess.size === 0) {
      console.log("[Agent] No new links found in this iteration.");
      yield {
        stage: "search",
        message: "No new sources found in this iteration",
      };
      // Decide whether to stop or try different queries - for now, we check for new queries later
    } else {
      console.log(`[Agent] Processing ${linksToProcess.size} unique links...`);
      yield {
        stage: "processing",
        message: `Found ${linksToProcess.size} unique sources to process`,
      };
    }

    // --- Process Links Concurrently ---
    yield {
      stage: "scraping",
      message: "Fetching and analyzing web content",
    };

    const linkProcessingPromises = Array.from(linksToProcess.entries()).map(
      ([urlString, query]) => {
        try {
          const url = new URL(urlString);
          return processLink(url, query, userQuery, services);
        } catch (e) {
          console.warn(
            `[Agent] Invalid URL string encountered: ${urlString}`,
            e,
          );
          return Promise.resolve(null); // Skip invalid URLs
        }
      },
    );
    const processedResults = await Promise.all(linkProcessingPromises);

    // --- Aggregate Contexts from this Iteration ---
    let iterationContextCount = 0;
    processedResults.forEach((result) => {
      if (result) {
        aggregatedContexts.push(result.context);
        allUsedSources.add(result.source); // Add source URL to the set
        iterationContextCount++;
      }
    });
    console.log(
      `[Agent] Added ${iterationContextCount} new contexts in iteration ${iteration + 1}. Total contexts: ${aggregatedContexts.length}`,
    );

    yield {
      stage: "scraping",
      message: `Extracted relevant information from ${iterationContextCount} sources`,
      detail: {
        totalSourcesProcessed: allUsedSources.size,
        newInThisIteration: iterationContextCount,
      },
    };

    // ----- 3. Decide Next Step -----
    console.log("[Agent] Asking LLM if further research is needed...");
    yield {
      stage: "evaluation",
      message:
        "Evaluating research depth and determining if more queries are needed",
    };

    const nextQueriesPrompt = PROMPTS.getNewQueries(
      userQuery,
      allUsedSearchQueries,
      aggregatedContexts,
    );
    const nextQueriesResponse = await services.llm.chatCompletion([
      {
        role: "system",
        content:
          "You decide if more research is needed and provide new queries as a JSON array, or an empty array [] if done.",
      },
      { role: "user", content: nextQueriesPrompt },
    ]);
    const newSearchQueries = await parseJsonArrayResponse(
      nextQueriesResponse,
      SearchQueryListSchema,
    );

    if (newSearchQueries === null) {
      console.warn(
        "[Agent] LLM failed to provide a valid decision on next steps. Ending research.",
      );
      yield {
        stage: "evaluation",
        message: "Couldn't determine next steps - completing current research",
      };
      break; // LLM failed to respond correctly
    }

    if (newSearchQueries.length === 0) {
      console.log("[Agent] LLM indicated research is complete.");
      yield {
        stage: "evaluation",
        message: "Research depth is sufficient - moving to final report",
      };
      break; // Research complete
    }

    // Filter out queries we've already used
    const uniqueNewQueries = newSearchQueries.filter(
      (q) => !allUsedSearchQueries.includes(q),
    );
    if (uniqueNewQueries.length === 0) {
      console.log(
        "[Agent] LLM suggested queries that were already used. Ending research.",
      );
      yield {
        stage: "evaluation",
        message: "No new research directions found - moving to final report",
      };
      break;
    }

    console.log(
      `[Agent] LLM suggested new queries: ${JSON.stringify(uniqueNewQueries)}`,
    );
    currentSearchQueries = uniqueNewQueries; // Use these for the next iteration
    allUsedSearchQueries.push(...currentSearchQueries);

    yield {
      stage: "evaluation",
      message: `Identified ${uniqueNewQueries.length} new search directions`,
      detail: { newQueries: uniqueNewQueries },
    };

    if (iterationLimit === iteration) {
      console.log(`[Agent] Reached iteration limit (${iterationLimit}).`);
      yield {
        stage: "iteration",
        message: `Reached iteration limit (${iterationLimit})`,
      };
      break;
    }
  } // End of iteration loop

  // ----- 4. Generate Final Report -----
  console.log("\n[Agent] Generating final report...");
  yield {
    stage: "report",
    message: "Synthesizing findings into final research report",
    progress: 90,
  };

  if (aggregatedContexts.length === 0) {
    console.warn(
      "[Agent] No relevant contexts were gathered. Generating report based on query only (might be limited).",
    );
    yield {
      stage: "report",
      message: "Warning: Limited research data available for report",
    };
    // Potentially return a specific message or throw an error? For now, let LLM try.
  }
  const reportPrompt = PROMPTS.generateReport(userQuery, aggregatedContexts);
  const finalReportText = await services.llm.chatCompletion([
    { role: "system", content: "You are a skilled report writer." },
    { role: "user", content: reportPrompt },
  ]);

  console.log("[Agent] Research process finished.");
  yield {
    stage: "complete",
    message: "Research complete",
    progress: 100,
    detail: {
      sourcesUsed: allUsedSources.size,
      queriesUsed: allUsedSearchQueries.length,
    },
  };

  return ResearchReportSchema.parse({
    // Use Zod to ensure final output shape
    report: finalReportText || "Failed to generate report.", // Handle empty LLM response
    usedQueries: allUsedSearchQueries,
    usedSources: Array.from(allUsedSources).map((s) => s.href), // Convert Set to Array
  });
}

// Example Usage (Conceptual - requires concrete service implementations)
/*
async function runExample() {
    // Assume these are implemented and configured elsewhere
    const llmService = new OpenRouterService(config.openRouterApiKey);
    const searchService = new SerpApiService(config.serpApiKey);
    const scraperService = new JinaScraperService(config.jinaApiKey);

    const input: ResearchTaskInput = {
        userQuery: "What are the latest advancements in quantum computing?",
        iterationLimit: 3
    };

    try {
        const report = await runResearchTask(input, {
            llm: llmService,
            search: searchService,
            scraper: scraperService
        });
        console.log("\n==== FINAL REPORT ====\n");
        console.log(report.report);
        console.log("\n==== METADATA ====");
        console.log("Used Queries:", report.usedQueries);
        console.log("Used Sources:", report.usedSources.map(url => url.toString()));

    } catch (error) {
        console.error("\n==== RESEARCH FAILED ====");
        console.error(error);
    }
}

// runExample(); // Uncomment to run if services are implemented
*/
