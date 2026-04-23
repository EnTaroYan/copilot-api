import { state } from "~/lib/state"

/**
 * Normalizes model identifiers sent by clients to the ones actually supported
 * by GitHub Copilot's upstream.
 *
 * Claude Code subagents / agent teams emit names using dash-separated version
 * numbers such as `claude-opus-4-6`, `claude-sonnet-4-5`, `claude-haiku-4-5`.
 * Copilot exposes those models with a dot in the version (`claude-opus-4.6`
 * etc.), so the dash form is rejected with `model_not_supported`.
 *
 * Strategy:
 *  1. If the name already matches something Copilot advertises, leave it.
 *  2. Otherwise convert a trailing `-N-M` segment to `-N.M` and check again.
 *  3. Finally fall back to the base family name (`claude-opus-4`,
 *     `claude-sonnet-4`, ...) if that is advertised.
 *  4. If none of the above hit, return the original so the upstream error is
 *     surfaced to the caller instead of being silently rewritten.
 */
export function translateModelName(model: string): string {
  const available = new Set(state.models?.data.map((m) => m.id) ?? [])

  if (available.size === 0) {
    // Model list not yet populated — fall back to legacy collapse behaviour.
    return legacyCollapse(model)
  }

  if (available.has(model)) {
    return model
  }

  // `claude-opus-4-6` -> `claude-opus-4.6`
  // `claude-opus-4-6-1m` -> `claude-opus-4.6-1m`
  const dashMatch =
    /^(claude-(?:opus|sonnet|haiku))-(\d+)-(\d+)(-[a-z0-9]+)?$/.exec(model)
  if (dashMatch) {
    const family = dashMatch[1]
    const major = dashMatch[2]
    const minor = dashMatch[3]
    const tail = dashMatch[4] as string | undefined
    const dotted = `${family}-${major}.${minor}${tail ?? ""}`
    if (available.has(dotted)) {
      return dotted
    }
  }

  // Fall back to the base family name, e.g. `claude-opus-4`.
  const baseMatch = /^(claude-(?:opus|sonnet|haiku)-\d+)/.exec(model)
  if (baseMatch && available.has(baseMatch[1])) {
    return baseMatch[1]
  }

  return model
}

function legacyCollapse(model: string): string {
  if (model.startsWith("claude-sonnet-4-")) {
    return model.replace(/^claude-sonnet-4-.*/, "claude-sonnet-4")
  } else if (model.startsWith("claude-opus-")) {
    return model.replace(/^claude-opus-4-.*/, "claude-opus-4")
  }
  return model
}
