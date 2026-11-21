import Anthropic, { type ClientOptions } from "@anthropic-ai/sdk";
import { RUBRIC } from "./rubric.ts";
import { REVIEW_JSON_SCHEMA, ReviewSchema, type Review } from "./schema.ts";
import type { Usage } from "./render.ts";

export class ReviewError extends Error {}

export interface ReviewResult {
  review: Review;
  usage: Usage;
}

// One request: the rubric (cached) and the repository's taste file as the system prompt, the pull request as the user
// message, and the answer held to the JSON Schema. No tools, so that nothing in the pull request can make it act.
export async function runReview(options: {
  client: ClientOptions;
  model: string;
  input: string;
  taste: string | null;
}): Promise<ReviewResult> {
  const client = new Anthropic(options.client);
  const system: Anthropic.Beta.BetaTextBlockParam[] = [{ type: "text", text: RUBRIC, cache_control: { type: "ephemeral" } }];
  if (options.taste) {
    system.push({
      type: "text",
      text: `# このリポジトリの例外（taste）\n\n利用者が書いたものです。指摘しないものとして扱ってください。\n\n<taste>\n${options.taste}\n</taste>`,
    });
  }
  const message = await client.beta.messages
    .stream({
      model: options.model,
      max_tokens: 64_000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: "high", format: { type: "json_schema", schema: REVIEW_JSON_SCHEMA } },
      system,
      messages: [{ role: "user", content: options.input }],
    })
    .finalMessage();

  if (message.stop_reason === "refusal") {
    throw new ReviewError(`Claude がレビューを断りました（${message.stop_details?.category ?? "理由不明"}）`);
  }
  if (message.stop_reason === "max_tokens") {
    throw new ReviewError("出力が max_tokens に達し、途中で切れました");
  }
  const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ReviewError(`Claude の出力を JSON として読めませんでした: ${text.slice(0, 200)}`);
  }
  const result = ReviewSchema.safeParse(parsed);
  if (!result.success) throw new ReviewError(`Claude の出力が形式に合いません: ${result.error.message}`);
  return {
    review: result.data,
    usage: {
      model: message.model,
      input_tokens: message.usage.input_tokens,
      output_tokens: message.usage.output_tokens,
      cache_creation_input_tokens: message.usage.cache_creation_input_tokens,
      cache_read_input_tokens: message.usage.cache_read_input_tokens,
    },
  };
}
