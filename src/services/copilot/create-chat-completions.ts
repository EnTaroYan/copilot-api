import consola from "consola"
import { events } from "fetch-event-stream"

import {
  copilotHeaders,
  copilotBaseUrl,
  clampUserField,
} from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

import {
  createChatCompletionsViaResponses,
  isResponsesOnlyModel,
  isUnsupportedApiForModelError,
  rememberResponsesOnlyModel,
} from "./responses-bridge"

export const createChatCompletions = async (
  payload: ChatCompletionsPayload,
) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const enableVision = payload.messages.some(
    (x) =>
      typeof x.content !== "string"
      && x.content?.some((x) => x.type === "image_url"),
  )

  // Agent/user check for X-Initiator header
  // Determine if any message is from an agent ("assistant" or "tool")
  const isAgentCall = payload.messages.some((msg) =>
    ["assistant", "tool"].includes(msg.role),
  )

  // Build headers and add X-Initiator
  const headers: Record<string, string> = {
    ...copilotHeaders(state, enableVision),
    "X-Initiator": isAgentCall ? "agent" : "user",
  }

  // Some models (e.g. gpt-5.5, gpt-5-pro) only work via /responses upstream.
  // Route those through the bridge so callers see ChatCompletions semantics.
  if (isResponsesOnlyModel(payload.model)) {
    return createChatCompletionsViaResponses(payload, headers)
  }

  const upstreamPayload = clampUserField(adaptPayloadForModel(payload))

  const response = await fetch(`${copilotBaseUrl(state)}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(upstreamPayload),
  })

  if (!response.ok) {
    // Adaptive fallback: if upstream rejects this model on /chat/completions,
    // remember it and retry through the responses bridge. Use clone() so the
    // original Response stays intact for HTTPError if detection fails.
    if (
      response.status === 400
      && (await isUnsupportedApiForModelError(response.clone()))
    ) {
      consola.warn(
        `Model "${payload.model}" not accessible via /chat/completions; `
          + `routing through /responses bridge.`,
      )
      rememberResponsesOnlyModel(payload.model)
      return createChatCompletionsViaResponses(payload, headers)
    }

    consola.error("Failed to create chat completions", response)
    throw new HTTPError("Failed to create chat completions", response)
  }

  if (payload.stream) {
    return events(response)
  }

  return (await response.json()) as ChatCompletionResponse
}

/**
 * Some upstream models (GPT-5 family, o1/o3/o4 reasoning series, gpt-5-codex,
 * etc.) reject the legacy `max_tokens` field with:
 *   "Unsupported parameter: 'max_tokens' is not supported with this model.
 *    Use 'max_completion_tokens' instead."
 *
 * Clients (Claude Code via /v1/messages, OpenAI SDKs, etc.) still send
 * `max_tokens`, so we rename it on the way out for those models. We also drop
 * `temperature`/`top_p` when the upstream rejects them on reasoning models —
 * but only when they equal the defaults, to avoid silently changing behavior.
 */
function adaptPayloadForModel(payload: ChatCompletionsPayload):
  | ChatCompletionsPayload
  | (Omit<ChatCompletionsPayload, "max_tokens"> & {
      max_completion_tokens?: number | null
    }) {
  if (!modelRequiresMaxCompletionTokens(payload.model)) {
    return payload
  }

  const { max_tokens, ...rest } = payload
  if (max_tokens === undefined || max_tokens === null) {
    return rest
  }
  return { ...rest, max_completion_tokens: max_tokens }
}

function modelRequiresMaxCompletionTokens(model: string): boolean {
  const id = model.toLowerCase()
  // GPT-5 family (incl. gpt-5-codex, gpt-5-mini, gpt-5.x)
  if (id.startsWith("gpt-5")) return true
  // OpenAI reasoning model series: o1, o3, o4 (e.g. o1-mini, o3-mini, o4-mini)
  if (/^o[134](?:[-.]|$)/.test(id)) return true
  return false
}

// Streaming types

export interface ChatCompletionChunk {
  id: string
  object: "chat.completion.chunk"
  created: number
  model: string
  choices: Array<Choice>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
    completion_tokens_details?: {
      accepted_prediction_tokens: number
      rejected_prediction_tokens: number
    }
  }
}

interface Delta {
  content?: string | null
  role?: "user" | "assistant" | "system" | "tool"
  tool_calls?: Array<{
    index: number
    id?: string
    type?: "function"
    function?: {
      name?: string
      arguments?: string
    }
  }>
}

interface Choice {
  index: number
  delta: Delta
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null
  logprobs: object | null
}

// Non-streaming types

export interface ChatCompletionResponse {
  id: string
  object: "chat.completion"
  created: number
  model: string
  choices: Array<ChoiceNonStreaming>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
  }
}

interface ResponseMessage {
  role: "assistant"
  content: string | null
  tool_calls?: Array<ToolCall>
}

interface ChoiceNonStreaming {
  index: number
  message: ResponseMessage
  logprobs: object | null
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter"
}

// Payload types

export interface ChatCompletionsPayload {
  messages: Array<Message>
  model: string
  temperature?: number | null
  top_p?: number | null
  max_tokens?: number | null
  stop?: string | Array<string> | null
  n?: number | null
  stream?: boolean | null

  frequency_penalty?: number | null
  presence_penalty?: number | null
  logit_bias?: Record<string, number> | null
  logprobs?: boolean | null
  response_format?: { type: "json_object" } | null
  seed?: number | null
  tools?: Array<Tool> | null
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; function: { name: string } }
    | null
  user?: string | null
}

export interface Tool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
  }
}

export interface Message {
  role: "user" | "assistant" | "system" | "tool" | "developer"
  content: string | Array<ContentPart> | null

  name?: string
  tool_calls?: Array<ToolCall>
  tool_call_id?: string
}

export interface ToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export type ContentPart = TextPart | ImagePart

export interface TextPart {
  type: "text"
  text: string
}

export interface ImagePart {
  type: "image_url"
  image_url: {
    url: string
    detail?: "low" | "high" | "auto"
  }
}
