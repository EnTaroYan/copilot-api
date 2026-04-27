import { test, expect } from "bun:test"

import type { ChatCompletionsPayload } from "../src/services/copilot/create-chat-completions"
import type { Model } from "../src/services/copilot/get-models"

import { state } from "../src/lib/state"
import {
  chatCompletionsToResponsesPayload,
  isResponsesOnlyModel,
  rememberResponsesOnlyModel,
  responsesObjectToChatCompletion,
  responsesEventsToChatChunks,
} from "../src/services/copilot/responses-bridge"

function makeModel(id: string, supported_endpoints?: Array<string>): Model {
  return {
    id,
    name: id,
    object: "model",
    vendor: "test",
    version: "1",
    preview: false,
    model_picker_enabled: true,
    capabilities: {
      family: id,
      object: "model_capabilities",
      supports: {},
      tokenizer: "cl100k_base",
      type: "chat",
      limits: {},
    },
    ...(supported_endpoints ? { supported_endpoints } : {}),
  }
}

test("isResponsesOnlyModel matches static gpt-5.5 / gpt-5-pro", () => {
  expect(isResponsesOnlyModel("gpt-5.5")).toBe(true)
  expect(isResponsesOnlyModel("GPT-5.5")).toBe(true)
  expect(isResponsesOnlyModel("gpt-5-pro")).toBe(true)
  expect(isResponsesOnlyModel("gpt-5")).toBe(false)
  expect(isResponsesOnlyModel("gpt-4o")).toBe(false)
})

test("isResponsesOnlyModel uses upstream supported_endpoints when available", () => {
  const previous = state.models
  state.models = {
    object: "list",
    data: [
      makeModel("future-responses-only", ["/responses"]),
      makeModel("future-chat-only", ["/chat/completions"]),
      makeModel("future-both", ["/chat/completions", "/responses"]),
      // gpt-5.5 with explicit chat support should override the static set.
      makeModel("gpt-5.5", ["/chat/completions"]),
    ],
  }
  try {
    expect(isResponsesOnlyModel("future-responses-only")).toBe(true)
    expect(isResponsesOnlyModel("future-chat-only")).toBe(false)
    expect(isResponsesOnlyModel("future-both")).toBe(false)
    // Upstream signal beats the static fallback set.
    expect(isResponsesOnlyModel("gpt-5.5")).toBe(false)
    // Model not in upstream list still falls back to static set.
    expect(isResponsesOnlyModel("gpt-5-pro")).toBe(true)
  } finally {
    state.models = previous
  }
})

test("rememberResponsesOnlyModel adds to runtime cache", () => {
  expect(isResponsesOnlyModel("gpt-x-future")).toBe(false)
  rememberResponsesOnlyModel("gpt-x-future")
  expect(isResponsesOnlyModel("gpt-x-future")).toBe(true)
  expect(isResponsesOnlyModel("GPT-X-FUTURE")).toBe(true)
})

test("chatCompletionsToResponsesPayload folds system + developer into instructions", () => {
  const p: ChatCompletionsPayload = {
    model: "gpt-5.5",
    messages: [
      { role: "system", content: "you are a helpful assistant" },
      { role: "developer", content: "follow rules" },
      { role: "user", content: "hi" },
    ],
  }
  const r = chatCompletionsToResponsesPayload(p)
  expect(r.instructions).toBe("you are a helpful assistant\n\nfollow rules")
  expect(r.input).toHaveLength(1)
  expect(r.input[0]).toMatchObject({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "hi" }],
  })
})

test("chatCompletionsToResponsesPayload maps tools and tool_choice", () => {
  const p: ChatCompletionsPayload = {
    model: "gpt-5.5",
    messages: [{ role: "user", content: "x" }],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Gets the weather",
          parameters: { type: "object" },
        },
      },
    ],
    tool_choice: { type: "function", function: { name: "get_weather" } },
    max_tokens: 256,
  }
  const r = chatCompletionsToResponsesPayload(p)
  expect(r.tools).toEqual([
    {
      type: "function",
      name: "get_weather",
      description: "Gets the weather",
      parameters: { type: "object" },
    },
  ])
  expect(r.tool_choice).toEqual({ type: "function", name: "get_weather" })
  expect(r.max_output_tokens).toBe(256)
})

test("chatCompletionsToResponsesPayload maps assistant tool_calls and tool result", () => {
  const p: ChatCompletionsPayload = {
    model: "gpt-5.5",
    messages: [
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "sunny" },
    ],
  }
  const r = chatCompletionsToResponsesPayload(p)
  expect(r.input).toHaveLength(3)
  expect(r.input[1]).toEqual({
    type: "function_call",
    call_id: "call_1",
    name: "get_weather",
    arguments: "{}",
  })
  expect(r.input[2]).toEqual({
    type: "function_call_output",
    call_id: "call_1",
    output: "sunny",
  })
})

test("responsesObjectToChatCompletion translates text + function_call output", () => {
  const cc = responsesObjectToChatCompletion(
    {
      id: "resp_123",
      model: "gpt-5.5",
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Hello" }],
        },
        {
          type: "function_call",
          call_id: "call_1",
          name: "get_weather",
          arguments: '{"city":"SF"}',
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    },
    "gpt-5.5",
  )
  expect(cc.id).toBe("resp_123")
  expect(cc.choices[0].message.content).toBe("Hello")
  expect(cc.choices[0].message.tool_calls).toEqual([
    {
      id: "call_1",
      type: "function",
      function: { name: "get_weather", arguments: '{"city":"SF"}' },
    },
  ])
  expect(cc.choices[0].finish_reason).toBe("tool_calls")
  expect(cc.usage).toEqual({
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
  })
})

test("responsesObjectToChatCompletion maps incomplete max_output_tokens to length", () => {
  const cc = responsesObjectToChatCompletion(
    {
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "..." }],
        },
      ],
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
    },
    "gpt-5.5",
  )
  expect(cc.choices[0].finish_reason).toBe("length")
})

async function collect(stream: AsyncIterable<{ data: string }>) {
  const out: Array<{ data: string }> = []
  for await (const e of stream) out.push(e)
  return out
}

function fromArray(arr: Array<{ data: string }>) {
  // eslint-disable-next-line @typescript-eslint/require-await
  async function* gen() {
    for (const e of arr) yield e
  }
  return gen()
}

test("responsesEventsToChatChunks streams text deltas", async () => {
  const events = fromArray([
    { data: JSON.stringify({ type: "response.created" }) },
    {
      data: JSON.stringify({
        type: "response.output_text.delta",
        delta: "Hel",
      }),
    },
    {
      data: JSON.stringify({
        type: "response.output_text.delta",
        delta: "lo",
      }),
    },
    {
      data: JSON.stringify({
        type: "response.completed",
        response: {
          status: "completed",
          usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
        },
      }),
    },
  ])

  const chunks = await collect(responsesEventsToChatChunks(events, "gpt-5.5"))
  // role chunk + 2 deltas + final + [DONE]
  expect(chunks).toHaveLength(5)
  expect(chunks.at(-1).data).toBe("[DONE]")

  const parsed = chunks.slice(0, 4).map(
    (c) =>
      JSON.parse(c.data) as {
        choices: Array<{
          delta: { role?: string; content?: string }
          finish_reason: string | null
        }>
        usage?: { total_tokens: number }
      },
  )
  expect(parsed[0].choices[0].delta.role).toBe("assistant")
  expect(parsed[1].choices[0].delta.content).toBe("Hel")
  expect(parsed[2].choices[0].delta.content).toBe("lo")
  expect(parsed[3].choices[0].finish_reason).toBe("stop")
  expect(parsed[3].usage?.total_tokens).toBe(3)
})

test("responsesEventsToChatChunks preserves parallel tool call indexes by item_id", async () => {
  const events = fromArray([
    { data: JSON.stringify({ type: "response.created" }) },
    {
      data: JSON.stringify({
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_a",
          call_id: "call_a",
          name: "tool_a",
        },
      }),
    },
    {
      data: JSON.stringify({
        type: "response.output_item.added",
        output_index: 1,
        item: {
          type: "function_call",
          id: "fc_b",
          call_id: "call_b",
          name: "tool_b",
        },
      }),
    },
    // interleaved arg deltas
    {
      data: JSON.stringify({
        type: "response.function_call_arguments.delta",
        item_id: "fc_a",
        delta: '{"x',
      }),
    },
    {
      data: JSON.stringify({
        type: "response.function_call_arguments.delta",
        item_id: "fc_b",
        delta: '{"y',
      }),
    },
    {
      data: JSON.stringify({
        type: "response.function_call_arguments.delta",
        item_id: "fc_a",
        delta: '":1}',
      }),
    },
    {
      data: JSON.stringify({
        type: "response.function_call_arguments.delta",
        item_id: "fc_b",
        delta: '":2}',
      }),
    },
    {
      data: JSON.stringify({
        type: "response.completed",
        response: { status: "completed" },
      }),
    },
  ])

  const chunks = await collect(responsesEventsToChatChunks(events, "gpt-5.5"))
  // role, 2 added, 4 arg deltas, final, [DONE] = 9
  expect(chunks).toHaveLength(9)
  const parsed = chunks.slice(0, 8).map(
    (c) =>
      JSON.parse(c.data) as {
        choices: Array<{
          delta: {
            tool_calls?: Array<{
              index: number
              id?: string
              function: { name?: string; arguments?: string }
            }>
          }
          finish_reason: string | null
        }>
      },
  )
  // 2nd chunk is added for tool_a → index 0
  expect(parsed[1].choices[0].delta.tool_calls?.[0].index).toBe(0)
  expect(parsed[1].choices[0].delta.tool_calls?.[0].id).toBe("call_a")
  // 3rd chunk is added for tool_b → index 1
  expect(parsed[2].choices[0].delta.tool_calls?.[0].index).toBe(1)
  expect(parsed[2].choices[0].delta.tool_calls?.[0].id).toBe("call_b")
  // arg deltas keep the right index
  expect(parsed[3].choices[0].delta.tool_calls?.[0].index).toBe(0)
  expect(parsed[3].choices[0].delta.tool_calls?.[0].function.arguments).toBe(
    '{"x',
  )
  expect(parsed[4].choices[0].delta.tool_calls?.[0].index).toBe(1)
  expect(parsed[5].choices[0].delta.tool_calls?.[0].index).toBe(0)
  expect(parsed[6].choices[0].delta.tool_calls?.[0].index).toBe(1)
  expect(parsed[7].choices[0].finish_reason).toBe("tool_calls")
})

test("chatCompletionsToResponsesPayload throws on unsupported fields", async () => {
  const { createChatCompletionsViaResponses } =
    await import("../src/services/copilot/responses-bridge")
  const p: ChatCompletionsPayload = {
    model: "gpt-5.5",
    messages: [{ role: "user", content: "hi" }],
    logit_bias: { "1234": 5 },
  }
  let caught: Error | undefined
  try {
    await createChatCompletionsViaResponses(p, {})
  } catch (err) {
    caught = err as Error
  }
  expect(caught).toBeDefined()
  expect(caught?.message).toMatch(/logit_bias/)
})
