import consola from "consola"
import { events } from "fetch-event-stream"

import { copilotHeaders, copilotBaseUrl } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"

export interface ResponsesPayload {
  model: string
  input: string | Array<ResponseInputItem>
  instructions?: string | null
  stream?: boolean | null
  temperature?: number | null
  top_p?: number | null
  max_output_tokens?: number | null
  [key: string]: unknown
}

type ResponseInputItem = {
  type?: string
  role?: string
  content?: string | Array<{ type: string; [key: string]: unknown }>
  [key: string]: unknown
}

export const createResponses = async (payload: ResponsesPayload) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  const sanitized = stripUnsupportedTools(payload)

  const enableVision = hasVisionContent(sanitized)
  const isAgentCall = hasAgentMessages(sanitized)

  const headers: Record<string, string> = {
    ...copilotHeaders(state, enableVision),
    "X-Initiator": isAgentCall ? "agent" : "user",
  }

  const response = await fetch(`${copilotBaseUrl(state)}/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify(sanitized),
  })

  if (!response.ok) {
    consola.error("Failed to create responses", response)
    throw new HTTPError("Failed to create responses", response)
  }

  if (sanitized.stream) {
    return events(response)
  }

  return (await response.json()) as Record<string, unknown>
}

// Tools that Codex/clients send but Copilot's responses API does not accept.
// Silently drop them so startup validation on the client side succeeds while
// upstream doesn't reject the request with 400.
const UNSUPPORTED_TOOL_TYPES = new Set(["image_generation"])

function stripUnsupportedTools(payload: ResponsesPayload): ResponsesPayload {
  const tools = payload.tools
  if (!Array.isArray(tools) || tools.length === 0) return payload

  const filtered = tools.filter((t) => {
    const type = (t as { type?: string } | null)?.type
    if (type && UNSUPPORTED_TOOL_TYPES.has(type)) {
      consola.debug(
        `Stripping unsupported tool from responses payload: ${type}`,
      )
      return false
    }
    return true
  })

  if (filtered.length === tools.length) return payload

  const next: ResponsesPayload = { ...payload, tools: filtered }
  // If filtering leaves no tools at all, drop the field entirely to avoid
  // sending an empty array (some upstreams dislike it).
  if (filtered.length === 0) delete (next as Record<string, unknown>).tools
  return next
}

function hasVisionContent(payload: ResponsesPayload): boolean {
  if (typeof payload.input === "string") return false
  if (!Array.isArray(payload.input)) return false

  return payload.input.some((item) => {
    if (Array.isArray(item.content)) {
      return item.content.some((part) => part.type === "input_image")
    }
    return false
  })
}

function hasAgentMessages(payload: ResponsesPayload): boolean {
  if (typeof payload.input === "string") return false
  if (!Array.isArray(payload.input)) return false

  return payload.input.some((item) => {
    if (item.role === "assistant") return true
    if (item.type === "function_call_output") return true
    if (item.type === "function_call") return true
    return false
  })
}
