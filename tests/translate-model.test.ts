import { beforeEach, describe, expect, test } from "bun:test"

import { state } from "~/lib/state"
import { translateModelName } from "~/lib/translate-model"

function setAvailableModels(ids: Array<string>) {
  state.models = {
    object: "list",
    data: ids.map((id) => ({ id, object: "model" })),
  } as unknown as typeof state.models
}

describe("translateModelName", () => {
  beforeEach(() => {
    state.models = undefined
  })

  test("returns unchanged id when it is advertised", () => {
    setAvailableModels(["claude-opus-4.6", "claude-sonnet-4"])
    expect(translateModelName("claude-opus-4.6")).toBe("claude-opus-4.6")
  })

  test("maps dash-versioned opus to dotted version", () => {
    setAvailableModels(["claude-opus-4.6"])
    expect(translateModelName("claude-opus-4-6")).toBe("claude-opus-4.6")
  })

  test("maps dash-versioned sonnet to dotted version", () => {
    setAvailableModels(["claude-sonnet-4.5"])
    expect(translateModelName("claude-sonnet-4-5")).toBe("claude-sonnet-4.5")
  })

  test("maps dash-versioned haiku to dotted version", () => {
    setAvailableModels(["claude-haiku-4.5"])
    expect(translateModelName("claude-haiku-4-5")).toBe("claude-haiku-4.5")
  })

  test("preserves trailing suffix like -1m", () => {
    setAvailableModels(["claude-opus-4.6-1m"])
    expect(translateModelName("claude-opus-4-6-1m")).toBe("claude-opus-4.6-1m")
  })

  test("falls back to base family id when specific version absent", () => {
    setAvailableModels(["claude-sonnet-4"])
    expect(translateModelName("claude-sonnet-4-9")).toBe("claude-sonnet-4")
  })

  test("returns original id when nothing matches", () => {
    setAvailableModels(["claude-opus-4.6"])
    expect(translateModelName("claude-opus-4-9")).toBe("claude-opus-4-9")
  })

  test("uses legacy collapse when model list not loaded yet", () => {
    state.models = undefined
    expect(translateModelName("claude-opus-4-6")).toBe("claude-opus-4")
    expect(translateModelName("claude-sonnet-4-5")).toBe("claude-sonnet-4")
    expect(translateModelName("gpt-4o")).toBe("gpt-4o")
  })

  test("does not modify non-claude ids", () => {
    setAvailableModels(["gpt-4o"])
    expect(translateModelName("gpt-4o")).toBe("gpt-4o")
  })
})
