import { ResearchServices } from "./interfaces.js";
import { JinaReaderService, JinaSearchService } from "./jina.js";
import { OpenAILLMService } from "./openai.js";
import { runResearchTask } from "./run-research-task.js";
import { ResearchReport } from "./schema.js";
import { serve } from "@hono/node-server";
import {
  A2AServer,
  type TaskContext,
  type TaskYieldUpdate,
  schema,
  InMemoryTaskStore,
  A2AServerOptions,
} from "hono-a2a-server";

const services: ResearchServices = {
  llm: new OpenAILLMService(),
  scraper: new JinaReaderService(),
  search: new JinaSearchService(),
};

async function* deepResearchAgent(
  context: TaskContext,
): AsyncGenerator<TaskYieldUpdate, schema.Task | void, TaskYieldUpdate> {
  console.log(`[Agent Logic] Handling task: ${context.task.id}`);
  const userPrompt = context.userMessage.parts
    .map((p) => p.type === "text" && p.text)
    .filter(Boolean)
    .join("\n");

  console.log(`[Agent Logic] User Prompt: ${userPrompt}`);

  // Indicate work is starting
  yield {
    state: "working",
    message: {
      role: "agent",
      parts: [{ text: `Processing request for task ${context.task.id}...` }],
    },
  };

  try {
    // Create the research task generator
    const researchGenerator = runResearchTask(
      {
        iterationLimit: 3,
        userQuery: userPrompt,
      },
      services,
    );

    // Iterate through the generator to get progress updates
    let finalReport: ResearchReport | null = null;

    for await (const progress of researchGenerator) {
      console.log(
        `[Agent Logic] Progress update: ${progress.stage} - ${progress.message}`,
      );

      // Check for cancellation
      if (context.isCancelled()) {
        console.log(`[Agent Logic] Task ${context.task.id} was cancelled.`);
        yield {
          state: "canceled",
          message: {
            role: "agent",
            parts: [{ text: "Task cancelled by user." }],
          },
        };
        return; // Stop processing
      }

      // Format a user-friendly message based on the progress
      let formattedMessage = progress.message;
      if (progress.progress !== undefined) {
        formattedMessage += ` (${progress.progress}% complete)`;
      }

      // Include relevant details if available
      if (progress.detail) {
        if (progress.stage === "queries" && progress.detail["queries"]) {
          const queries = progress.detail["queries"] as string[];
          if (queries.length > 0) {
            formattedMessage += `\nQueries: ${queries.join(", ")}`;
          }
        } else if (
          progress.stage === "scraping" &&
          progress.detail["totalSourcesProcessed"]
        ) {
          formattedMessage += `\nTotal sources processed: ${progress.detail["totalSourcesProcessed"]}`;
        } else if (
          progress.stage === "evaluation" &&
          progress.detail["newQueries"]
        ) {
          const newQueries = progress.detail["newQueries"] as string[];
          if (newQueries.length > 0) {
            formattedMessage += `\nNew queries: ${newQueries.join(", ")}`;
          }
        }
      }

      // Send progress update to client
      yield {
        state: "working",
        message: {
          role: "agent",
          parts: [{ type: "text", text: formattedMessage }],
        },
      };

      // Store the final result from the generator
      if (progress.stage === "complete") {
        const result = await researchGenerator.next();
        if (result.done && result.value) {
          finalReport = result.value;
        }
        break;
      }
    }

    if (!finalReport) {
      throw new Error("Research process failed to produce a final report");
    }

    // Yield the final artifact (research report)
    yield {
      name: "report.md",
      parts: [
        {
          type: "text",
          text: finalReport.report,
        },
      ],
      metadata: {
        usedQueries: finalReport.usedQueries,
        usedSources: finalReport.usedSources.map((s) => s.href),
      },
    };

    yield {
      state: "completed",
      message: {
        role: "agent",
        parts: [
          {
            type: "text",
            text: "Research complete, see attached report.",
          },
        ],
      },
    };
  } catch (error) {
    console.error(`[Agent Logic] Error in research task:`, error);
    yield {
      state: "failed",
      message: {
        role: "agent",
        parts: [
          {
            type: "text",
            text: `An error occurred during the research process: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      },
    };
  }
}

// 2. Configure and Create the Server Instance
const agentCard: schema.AgentCard = {
  version: "1.0.0",
  name: "Deep Research Agent",
  description:
    "Deeply analyze a topic and generate a research report, using web search through dozens of sites and web scraping.",
  url: "http://localhost:41241",
  capabilities: {
    streaming: true,
  },
  skills: [
    {
      id: "research",
      name: "Research",
      description:
        "Research a topic and generate a research report, using web search through dozens of sites and web scraping.",
    },
  ],
};

const serverOptions: A2AServerOptions = {
  taskStore: new InMemoryTaskStore(),
  card: agentCard,
  cors: {
    // Example: Allow requests from any origin
    origin: "*",
  },
};

const server = new A2AServer(deepResearchAgent, serverOptions);

// 3. Start the Server
const port = Number(process.env["PORT"]) || 41241;
console.log(`Starting custom A2A server on port ${port}...`);

serve(
  {
    fetch: server.createApp().fetch, // Get the Hono app instance and pass its fetch handler
    port: port,
  },
  (info) => {
    console.log(
      `Custom A2A Server (Hono) listening on http://localhost:${info.port}`,
    );
  },
);
