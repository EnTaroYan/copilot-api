/**
 * Normalizes model identifiers sent by clients to the ones actually supported
 * by GitHub Copilot's upstream.
 *
 * Some clients (e.g. Claude Code subagents) request more specific versioned
 * names such as `claude-sonnet-4-5` or `claude-opus-4-6` which Copilot does
 * not recognize. We collapse them back to the base family name that Copilot
 * exposes (e.g. `claude-sonnet-4`, `claude-opus-4`).
 */
export function translateModelName(model: string): string {
  if (model.startsWith("claude-sonnet-4-")) {
    return model.replace(/^claude-sonnet-4-.*/, "claude-sonnet-4")
  } else if (model.startsWith("claude-opus-")) {
    return model.replace(/^claude-opus-4-.*/, "claude-opus-4")
  }
  return model
}
