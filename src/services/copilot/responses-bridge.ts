/**
 * Bridge: GitHub Copilot's `/responses` endpoint surfaced as ChatCompletions.
 *
 * Some upstream models (e.g. `gpt-5.5`, `gpt-5-pro`) are only accessible via
 * `/responses` and reject `/chat/completions` with
 * `unsupported_api_for_model`. To keep the existing pipelines working —
 * including the Anthropic `/v1/messages` translator used by Claude Code — we
 * translate ChatCompletions payloads into Responses payloads on the way out
 * and translate the Responses output (streaming and non-streaming) back into
 * ChatCompletions chunks/responses on the way back. From the perspective of
 * `createChatCompletions()` callers, nothing changes.
 *
 * Translation is intentionally limited to the subset that real clients in
 * this proxy actually use (Claude Code, Codex, OpenAI SDKs). Unsupported
 * ChatCompletions fields are detected and surfaced as a clear error rather
 * than silently dropped — see {@link assertBridgeCanHandle}.
 */

import consola from "consola"
import { events, type ServerSentEventMessage } from "fetch-event-stream"

import { copilotBaseUrl, clampUserField } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
  ContentPart,
  Message,
  ToolCall,
} from "./create-chat-completions"

// --- Detection ------------------------------------------------------------

/** Models known up-front to require the /responses endpoint. */
const STATIC_RESPONSES_ONLY_MODELS = new Set<string>(["gpt-5.5", "gpt-5-pro"])

/** Runtime cache populated by adaptive fallback. */
const learnedResponsesOnlyModels = new Set<string>()

export function isResponsesOnlyModel(model: string): boolean {
  const id = model.toLowerCase()
  return (
    STATIC_RESPONSES_ONLY_MODELS.has(id) || learnedResponsesOnlyModels.has(id)
  )
}

export function rememberResponsesOnlyModel(model: string): void {
  learnedResponsesOnlyModels.add(model.toLowerCase())
}

/**
 * Inspect a failed /chat/completions response (a clone — see caller) and
 * return true if the failure indicates the model is responses-only.
 */
export async function isUnsupportedApiForModelError(
  cloned: Response,
): Promise<boolean> {
  try {
    const text = await cloned.text()
    return text.includes("unsupported_api_for_model")
  } catch {
    return false
  }
}

// --- Bridge entry ---------------------------------------------------------

/**
 * Run a ChatCompletions request through the Responses upstream.
 * Returns either a ChatCompletionResponse (non-streaming) or an async
 * iterable of SSE messages whose `data` is a ChatCompletionChunk JSON
 * string — the same shape `events()` returns for /chat/completions.
 */
export async function createChatCompletionsViaResponses(
  payload: ChatCompletionsPayload,
  headers: Record<string, string>,
): Promise<ChatCompletionResponse | AsyncIterable<ServerSentEventMessage>> {
  assertBridgeCanHandle(payload)

  const responsesPayload = clampUserField(
    chatCompletionsToResponsesPayload(payload),
  )

  const response = await fetch(`${copilotBaseUrl(state)}/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify(responsesPayload),
  })

  if (!response.ok) {
    consola.error(
      "Failed to create chat completions via responses bridge",
      response,
    )
    throw new HTTPError(
      "Failed to create chat completions via responses bridge",
      response,
    )
  }

  if (payload.stream) {
    return responsesEventsToChatChunks(events(response), payload.model)
  }

  const json = (await response.json()) as ResponsesObject
  return responsesObjectToChatCompletion(json, payload.model)
}

// --- Capability check -----------------------------------------------------

/**
 * Hard-fail when a CC payload uses a feature the bridge can't faithfully
 * translate, instead of silently dropping. Better an explicit error than a
 * wrong answer.
 */
function assertBridgeCanHandle(payload: ChatCompletionsPayload): void {
  const unsupported: Array<string> = []
  if (payload.n !== undefined && payload.n !== null && payload.n !== 1) {
    unsupported.push("n")
  }
  if (isPresent(payload.frequency_penalty))
    unsupported.push("frequency_penalty")
  if (isPresent(payload.presence_penalty)) unsupported.push("presence_penalty")
  if (isPresent(payload.logit_bias)) unsupported.push("logit_bias")
  if (isPresent(payload.logprobs)) unsupported.push("logprobs")
  if (isPresent(payload.response_format)) unsupported.push("response_format")
  if (isPresent(payload.seed)) unsupported.push("seed")

  if (unsupported.length > 0) {
    throw new Error(
      `Model "${payload.model}" only supports the /responses endpoint, `
        + `but the request uses fields not bridged to Responses: `
        + unsupported.join(", "),
    )
  }
}

// --- Request translation: ChatCompletions -> Responses --------------------

interface ResponsesPayload {
  model: string
  input: Array<ResponsesInputItem>
  instructions?: string
  tools?: Array<ResponsesTool>
  tool_choice?: ResponsesToolChoice
  max_output_tokens?: number | null
  temperature?: number | null
  top_p?: number | null
  stream?: boolean | null
  user?: string | null
}

type ResponsesInputItem =
  | ResponsesMessageItem
  | ResponsesFunctionCallItem
  | ResponsesFunctionCallOutputItem

interface ResponsesMessageItem {
  type?: "message"
  role: "user" | "assistant" | "system"
  content: Array<ResponsesContentPart> | string
}

interface ResponsesFunctionCallItem {
  type: "function_call"
  call_id: string
  name: string
  arguments: string
}

interface ResponsesFunctionCallOutputItem {
  type: "function_call_output"
  call_id: string
  output: string
}

type ResponsesContentPart =
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string }
  | { type: "input_image"; image_url: string; detail?: string }

interface ResponsesTool {
  type: "function"
  name: string
  description?: string
  parameters: Record<string, unknown>
}

type ResponsesToolChoice =
  | "none"
  | "auto"
  | "required"
  | { type: "function"; name: string }

export function chatCompletionsToResponsesPayload(
  payload: ChatCompletionsPayload,
): ResponsesPayload {
  const { instructions, items } = splitMessagesForResponses(payload.messages)

  const responsesPayload: ResponsesPayload = {
    model: payload.model,
    input: items,
    stream: payload.stream ?? undefined,
    temperature: payload.temperature ?? undefined,
    top_p: payload.top_p ?? undefined,
    user: payload.user ?? undefined,
  }

  if (instructions) responsesPayload.instructions = instructions

  const maxOut =
    (payload as { max_completion_tokens?: number | null }).max_completion_tokens
    ?? payload.max_tokens
  if (isPresent(maxOut)) responsesPayload.max_output_tokens = maxOut

  if (payload.tools && payload.tools.length > 0) {
    responsesPayload.tools = payload.tools.map((t) => ({
      type: "function",
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    }))
  }

  if (isPresent(payload.tool_choice)) {
    responsesPayload.tool_choice = translateToolChoice(payload.tool_choice)
  }

  return responsesPayload
}

function translateToolChoice(
  choice: NonNullable<ChatCompletionsPayload["tool_choice"]>,
): ResponsesToolChoice {
  if (typeof choice === "string") return choice
  return { type: "function", name: choice.function.name }
}

function splitMessagesForResponses(messages: Array<Message>): {
  instructions: string
  items: Array<ResponsesInputItem>
} {
  const instructionsParts: Array<string> = []
  const items: Array<ResponsesInputItem> = []

  for (const msg of messages) {
    if (msg.role === "system" || msg.role === "developer") {
      const text = stringifyContent(msg.content)
      if (text) instructionsParts.push(text)
      continue
    }

    if (msg.role === "tool") {
      items.push({
        type: "function_call_output",
        call_id: msg.tool_call_id ?? "",
        output: stringifyContent(msg.content),
      })
      continue
    }

    if (msg.role === "assistant") {
      const text = stringifyContent(msg.content)
      if (text) {
        items.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        })
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          items.push({
            type: "function_call",
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          })
        }
      }
      continue
    }

    // role === "user"
    items.push({
      type: "message",
      role: "user",
      content: contentToResponsesInputParts(msg.content),
    })
  }

  return { instructions: instructionsParts.join("\n\n"), items }
}

function contentToResponsesInputParts(
  content: string | Array<ContentPart> | null,
): Array<ResponsesContentPart> {
  if (content === null) return []
  if (typeof content === "string") {
    return [{ type: "input_text", text: content }]
  }
  return content.map((part): ResponsesContentPart => {
    if (part.type === "text") {
      return { type: "input_text", text: part.text }
    }
    return {
      type: "input_image",
      image_url: part.image_url.url,
      detail: part.image_url.detail,
    }
  })
}

function stringifyContent(content: string | Array<ContentPart> | null): string {
  if (content === null) return ""
  if (typeof content === "string") return content
  return content
    .map((p) => (p.type === "text" ? p.text : ""))
    .filter(Boolean)
    .join("")
}

function isPresent<T>(v: T | null | undefined): v is T {
  return v !== null && v !== undefined
}

// --- Response translation (non-streaming) ---------------------------------

interface ResponsesObject {
  id?: string
  model?: string
  status?: string
  output?: Array<ResponsesOutputItem>
  usage?: {
    input_tokens?: number
    output_tokens?: number
    total_tokens?: number
    input_tokens_details?: { cached_tokens?: number }
  }
  incomplete_details?: { reason?: string }
}

type ResponsesOutputItem =
  | {
      type: "message"
      role?: string
      content?: Array<{ type: string; text?: string }>
    }
  | {
      type: "function_call"
      call_id?: string
      id?: string
      name?: string
      arguments?: string
    }
  | { type: string; [k: string]: unknown }

interface ResponsesOutputTextPart {
  type: string
  text?: string
}

interface ResponsesMessageOutput {
  type: "message"
  content?: Array<ResponsesOutputTextPart>
}

interface ResponsesFunctionCallOutput {
  type: "function_call"
  call_id?: string
  id?: string
  name?: string
  arguments?: string
}

function isMessageOutput(
  item: ResponsesOutputItem,
): item is ResponsesMessageOutput {
  return item.type === "message"
}

function isFunctionCallOutput(
  item: ResponsesOutputItem,
): item is ResponsesFunctionCallOutput {
  return item.type === "function_call"
}

function extractTextFromMessageItem(item: ResponsesMessageOutput): string {
  let text = ""
  for (const part of item.content ?? []) {
    if (part.type === "output_text" && typeof part.text === "string") {
      text += part.text
    }
  }
  return text
}

function functionCallItemToToolCall(
  item: ResponsesFunctionCallOutput,
): ToolCall {
  return {
    id: item.call_id ?? item.id ?? "",
    type: "function",
    function: {
      name: item.name ?? "",
      arguments: item.arguments ?? "",
    },
  }
}

function deriveFinishReason(
  status: string | undefined,
  incompleteReason: string | undefined,
  hasToolCalls: boolean,
): "stop" | "length" | "tool_calls" {
  if (status === "incomplete" && incompleteReason === "max_output_tokens") {
    return "length"
  }
  if (hasToolCalls) return "tool_calls"
  return "stop"
}

function mapResponsesUsage(
  usage: ResponsesObject["usage"],
): ChatCompletionResponse["usage"] {
  if (!usage) return undefined
  const out: NonNullable<ChatCompletionResponse["usage"]> = {
    prompt_tokens: usage.input_tokens ?? 0,
    completion_tokens: usage.output_tokens ?? 0,
    total_tokens: usage.total_tokens ?? 0,
  }
  if (usage.input_tokens_details) {
    out.prompt_tokens_details = {
      cached_tokens: usage.input_tokens_details.cached_tokens ?? 0,
    }
  }
  return out
}

export function responsesObjectToChatCompletion(
  resp: ResponsesObject,
  modelHint: string,
): ChatCompletionResponse {
  let text = ""
  const toolCalls: Array<ToolCall> = []

  for (const item of resp.output ?? []) {
    if (isMessageOutput(item)) {
      text += extractTextFromMessageItem(item)
    } else if (isFunctionCallOutput(item)) {
      toolCalls.push(functionCallItemToToolCall(item))
    }
    // reasoning and other item types: ignored
  }

  const finishReason = deriveFinishReason(
    resp.status,
    resp.incomplete_details?.reason,
    toolCalls.length > 0,
  )

  return {
    id: resp.id ?? "",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: resp.model ?? modelHint,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        logprobs: null,
        finish_reason: finishReason,
      },
    ],
    usage: mapResponsesUsage(resp.usage),
  }
}

// --- Response translation (streaming) -------------------------------------

interface ResponsesStreamEvent {
  type?: string
  // common shapes:
  delta?: string
  item_id?: string
  output_index?: number
  item?: {
    type?: string
    id?: string
    call_id?: string
    name?: string
    role?: string
  }
  response?: ResponsesObject
}

/**
 * Translate the Responses SSE stream to a ChatCompletions SSE stream. We
 * yield messages whose `.data` is a JSON-stringified `ChatCompletionChunk`,
 * matching what fetch-event-stream's `events()` yields for /chat/completions.
 */
export async function* responsesEventsToChatChunks(
  source: AsyncIterable<ServerSentEventMessage>,
  modelHint: string,
): AsyncIterable<ServerSentEventMessage> {
  const ctx: BridgeStreamContext = {
    responseId: `chatcmpl-bridge-${Date.now()}`,
    created: Math.floor(Date.now() / 1000),
    modelHint,
    toolCallIndexById: new Map<string, number>(),
    nextToolCallIndex: 0,
    sawAnyToolCall: false,
    roleEmitted: false,
  }

  for await (const raw of source) {
    if (!raw.data || raw.data === "[DONE]") continue

    const evt = parseStreamEvent(raw.data)
    if (!evt) continue

    const type = evt.type ?? raw.event ?? ""
    yield* handleStreamEvent(type, evt, ctx)
  }

  yield { data: "[DONE]" }
}

interface BridgeStreamContext {
  responseId: string
  created: number
  modelHint: string
  toolCallIndexById: Map<string, number>
  nextToolCallIndex: number
  sawAnyToolCall: boolean
  roleEmitted: boolean
}

function parseStreamEvent(data: string): ResponsesStreamEvent | null {
  try {
    return JSON.parse(data) as ResponsesStreamEvent
  } catch {
    return null
  }
}

interface EmitChunkOptions {
  finishReason?: ChatCompletionChunk["choices"][number]["finish_reason"]
  usage?: ChatCompletionChunk["usage"]
}

function emitChunk(
  ctx: BridgeStreamContext,
  delta: ChatCompletionChunk["choices"][number]["delta"],
  options: EmitChunkOptions = {},
): ServerSentEventMessage {
  const { finishReason = null, usage } = options
  const chunk: ChatCompletionChunk = {
    id: ctx.responseId,
    object: "chat.completion.chunk",
    created: ctx.created,
    model: ctx.modelHint,
    choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
    ...(usage ? { usage } : {}),
  }
  return { data: JSON.stringify(chunk) }
}

function* ensureRoleEmitted(
  ctx: BridgeStreamContext,
): Generator<ServerSentEventMessage> {
  if (!ctx.roleEmitted) {
    ctx.roleEmitted = true
    yield emitChunk(ctx, { role: "assistant" })
  }
}

function* handleStreamEvent(
  type: string,
  evt: ResponsesStreamEvent,
  ctx: BridgeStreamContext,
): Generator<ServerSentEventMessage> {
  if (type === "response.created") {
    yield* ensureRoleEmitted(ctx)
    return
  }
  if (type === "response.output_item.added" && evt.item) {
    yield* handleOutputItemAdded(evt, ctx)
    return
  }
  if (type === "response.output_text.delta" && typeof evt.delta === "string") {
    yield* ensureRoleEmitted(ctx)
    yield emitChunk(ctx, { content: evt.delta })
    return
  }
  if (
    type === "response.function_call_arguments.delta"
    && typeof evt.delta === "string"
    && evt.item_id
  ) {
    yield* handleFunctionCallArgsDelta(evt, ctx)
    return
  }
  if (type === "response.completed" && evt.response) {
    yield handleResponseCompleted(evt.response, ctx)
    return
  }
  // Other events (output_text.done, output_item.done, content_part.added,
  // reasoning*, in_progress, etc.) are intentionally ignored.
}

function* handleOutputItemAdded(
  evt: ResponsesStreamEvent,
  ctx: BridgeStreamContext,
): Generator<ServerSentEventMessage> {
  const item = evt.item
  if (!item || item.type !== "function_call") return

  const itemId =
    item.id
    ?? item.call_id
    ?? `idx-${evt.output_index ?? ctx.nextToolCallIndex}`
  const tcIndex = ctx.nextToolCallIndex++
  ctx.toolCallIndexById.set(itemId, tcIndex)
  ctx.sawAnyToolCall = true

  yield* ensureRoleEmitted(ctx)
  yield emitChunk(ctx, {
    tool_calls: [
      {
        index: tcIndex,
        id: item.call_id ?? item.id ?? "",
        type: "function",
        function: { name: item.name ?? "", arguments: "" },
      },
    ],
  })
}

function* handleFunctionCallArgsDelta(
  evt: ResponsesStreamEvent,
  ctx: BridgeStreamContext,
): Generator<ServerSentEventMessage> {
  const itemId = evt.item_id
  if (!itemId || typeof evt.delta !== "string") return

  let tcIndex = ctx.toolCallIndexById.get(itemId)
  if (tcIndex === undefined) {
    // Defensive: arguments delta arrived before output_item.added.
    tcIndex = ctx.nextToolCallIndex++
    ctx.toolCallIndexById.set(itemId, tcIndex)
    ctx.sawAnyToolCall = true
  }
  yield emitChunk(ctx, {
    tool_calls: [{ index: tcIndex, function: { arguments: evt.delta } }],
  })
}

function handleResponseCompleted(
  r: ResponsesObject,
  ctx: BridgeStreamContext,
): ServerSentEventMessage {
  const finishReason = deriveFinishReason(
    r.status,
    r.incomplete_details?.reason,
    ctx.sawAnyToolCall,
  )
  return emitChunk(
    ctx,
    {},
    {
      finishReason,
      usage: mapResponsesUsage(r.usage),
    },
  )
}
