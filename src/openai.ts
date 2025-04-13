// Adjust path as needed
import { config } from "./config.js";
import { ILLMService } from "./interfaces.js";
import { ChatMessage } from "./schema.js";
import OpenAI from "openai";
import { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import pRetry from "p-retry";

// Adjust path as needed

export class OpenAILLMService implements ILLMService {
  private openai: OpenAI;
  private defaultModel: string;

  constructor() {
    if (!config.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is not configured.");
    }
    this.openai = new OpenAI({
      apiKey: config.OPENAI_API_KEY,
      baseURL: config.OPENAI_BASEURL,
    });
    this.defaultModel = config.OPENAI_DEFAULT_MODEL;
    console.log(
      `[OpenAILLMService] Initialized with model: ${this.defaultModel}`,
    );
  }

  async chatCompletion(
    messages: ChatMessage[],
    model?: string,
  ): Promise<string> {
    const targetModel = model || this.defaultModel;

    // Map internal ChatMessage to OpenAI's expected format
    const openAiMessages: ChatCompletionMessageParam[] = messages.map(
      (msg) => ({
        role: msg.role,
        content: msg.content,
      }),
    );

    const operation = async (): Promise<string> => {
      try {
        console.log(
          `[OpenAILLMService] Calling OpenAI model ${targetModel} with ${messages.length} messages...`,
        );
        const completion = await this.openai.chat.completions.create({
          model: targetModel,
          messages: openAiMessages,
        });

        const content = completion.choices?.[0]?.message?.content;

        if (content === null || content === undefined) {
          console.warn(
            "[OpenAILLMService] OpenAI response content is null or undefined.",
            completion,
          );
          // Throwing an error here will trigger retry if applicable for certain error types
          throw new Error("OpenAI response content is missing.");
        }

        console.log(
          `[OpenAILLMService] Received response from ${targetModel}.`,
        );
        return content;
      } catch (error: unknown) {
        console.error("[OpenAILLMService] Error calling OpenAI API:", error);
        // Rethrow specific errors if needed for retry logic, otherwise let p-retry handle generic errors
        if (error instanceof OpenAI.APIError) {
          // Potentially retry on 429 (rate limit) or 5xx (server errors)
          if (error.status === 429 || (error.status && error.status >= 500)) {
            throw error; // p-retry will catch this and retry
          }
        }
        // For other errors, or if no specific condition met, throw to fail the operation
        throw new Error(
          `OpenAI API call failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };

    try {
      // Retry on specific OpenAI API errors (rate limits, server errors) or network errors
      return await pRetry(operation, {
        retries: 3, // Number of retries
        minTimeout: 1000, // Initial delay ms
        factor: 2, // Exponential backoff factor
        onFailedAttempt: (error) => {
          console.warn(
            `[OpenAILLMService] Attempt ${error.attemptNumber} failed. Retrying in ${error.retriesLeft} attempts... Error: ${error.message}`,
          );
        },
      });
    } catch (finalError) {
      console.error(
        "[OpenAILLMService] Failed OpenAI chat completion after retries:",
        finalError,
      );

      throw finalError;
    }
  }
}
