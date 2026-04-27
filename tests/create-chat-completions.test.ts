import { test, expect, mock } from "bun:test"

import type { ChatCompletionsPayload } from "../src/services/copilot/create-chat-completions"

import { state } from "../src/lib/state"
import { createChatCompletions } from "../src/services/copilot/create-chat-completions"

// Mock state
state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

// Helper to mock fetch
const fetchMock = mock(
  (_url: string, opts: { headers: Record<string, string>; body?: string }) => {
    return {
      ok: true,
      json: () => ({ id: "123", object: "chat.completion", choices: [] }),
      headers: opts.headers,
      body: opts.body,
    }
  },
)
// @ts-expect-error - Mock fetch doesn't implement all fetch properties
;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock

test("sets X-Initiator to agent if tool/assistant present", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [
      { role: "user", content: "hi" },
      { role: "tool", content: "tool call" },
    ],
    model: "gpt-test",
  }
  await createChatCompletions(payload)
  expect(fetchMock).toHaveBeenCalled()
  const headers = (
    fetchMock.mock.calls[0][1] as { headers: Record<string, string> }
  ).headers
  expect(headers["X-Initiator"]).toBe("agent")
})

test("sets X-Initiator to user if only user present", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [
      { role: "user", content: "hi" },
      { role: "user", content: "hello again" },
    ],
    model: "gpt-test",
  }
  await createChatCompletions(payload)
  expect(fetchMock).toHaveBeenCalled()
  const headers = (
    fetchMock.mock.calls[1][1] as { headers: Record<string, string> }
  ).headers
  expect(headers["X-Initiator"]).toBe("user")
})

test("renames max_tokens to max_completion_tokens for gpt-5 family", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "hi" }],
    model: "gpt-5",
    max_tokens: 1234,
  }
  await createChatCompletions(payload)
  const body = JSON.parse(
    (
      fetchMock.mock.calls.at(-1)[1] as {
        body: string
      }
    ).body,
  ) as Record<string, unknown>
  expect(body.max_completion_tokens).toBe(1234)
  expect(body.max_tokens).toBeUndefined()
})

test("renames max_tokens for gpt-5-codex", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "hi" }],
    model: "gpt-5-codex",
    max_tokens: 8000,
  }
  await createChatCompletions(payload)
  const body = JSON.parse(
    (
      fetchMock.mock.calls.at(-1)[1] as {
        body: string
      }
    ).body,
  ) as Record<string, unknown>
  expect(body.max_completion_tokens).toBe(8000)
  expect(body.max_tokens).toBeUndefined()
})

test("renames max_tokens for o1/o3/o4 reasoning models", async () => {
  for (const model of ["o1-mini", "o3-mini", "o4-mini"]) {
    const payload: ChatCompletionsPayload = {
      messages: [{ role: "user", content: "hi" }],
      model,
      max_tokens: 100,
    }
    await createChatCompletions(payload)
    const body = JSON.parse(
      (
        fetchMock.mock.calls.at(-1)[1] as {
          body: string
        }
      ).body,
    ) as Record<string, unknown>
    expect(body.max_completion_tokens).toBe(100)
    expect(body.max_tokens).toBeUndefined()
  }
})

test("preserves max_tokens for non-reasoning / non-gpt-5 models", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "hi" }],
    model: "gpt-4o",
    max_tokens: 500,
  }
  await createChatCompletions(payload)
  const body = JSON.parse(
    (
      fetchMock.mock.calls.at(-1)[1] as {
        body: string
      }
    ).body,
  ) as Record<string, unknown>
  expect(body.max_tokens).toBe(500)
  expect(body.max_completion_tokens).toBeUndefined()
})

test("truncates user field longer than 64 chars to 64 chars", async () => {
  const longUser = "u".repeat(150)
  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "hi" }],
    model: "gpt-4o",
    user: longUser,
  }
  await createChatCompletions(payload)
  const body = JSON.parse(
    (
      fetchMock.mock.calls.at(-1)[1] as {
        body: string
      }
    ).body,
  ) as Record<string, unknown>
  expect(body.user).toBe("u".repeat(64))
})

test("leaves short user field unchanged", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "hi" }],
    model: "gpt-4o",
    user: "alice",
  }
  await createChatCompletions(payload)
  const body = JSON.parse(
    (
      fetchMock.mock.calls.at(-1)[1] as {
        body: string
      }
    ).body,
  ) as Record<string, unknown>
  expect(body.user).toBe("alice")
})
