import { randomUUID } from "node:crypto"

import type { State } from "./state"

export const standardHeaders = () => ({
  "content-type": "application/json",
  accept: "application/json",
})

const COPILOT_VERSION_FALLBACK = "0.45.1"
const copilotVersion = (state: State) =>
  state.copilotChatVersion ?? COPILOT_VERSION_FALLBACK
const editorPluginVersion = (state: State) =>
  `copilot-chat/${copilotVersion(state)}`
const userAgent = (state: State) => `GitHubCopilotChat/${copilotVersion(state)}`

const API_VERSION = "2025-04-01"

export const copilotBaseUrl = (state: State) =>
  state.accountType === "individual" ?
    "https://api.githubcopilot.com"
  : `https://api.${state.accountType}.githubcopilot.com`
export const copilotHeaders = (state: State, vision: boolean = false) => {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${state.copilotToken}`,
    "content-type": standardHeaders()["content-type"],
    "copilot-integration-id": "vscode-chat",
    "editor-version": `vscode/${state.vsCodeVersion}`,
    "editor-plugin-version": editorPluginVersion(state),
    "user-agent": userAgent(state),
    "openai-intent": "conversation-panel",
    "x-github-api-version": API_VERSION,
    "x-request-id": randomUUID(),
    "x-vscode-user-agent-library-version": "electron-fetch",
  }

  if (vision) headers["copilot-vision-request"] = "true"

  return headers
}

export const GITHUB_API_BASE_URL = "https://api.github.com"
export const githubHeaders = (state: State) => ({
  ...standardHeaders(),
  authorization: `token ${state.githubToken}`,
  "editor-version": `vscode/${state.vsCodeVersion}`,
  "editor-plugin-version": editorPluginVersion(state),
  "user-agent": userAgent(state),
  "x-github-api-version": API_VERSION,
  "x-vscode-user-agent-library-version": "electron-fetch",
})

export const GITHUB_BASE_URL = "https://github.com"
export const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98"
export const GITHUB_APP_SCOPES = ["read:user"].join(" ")

/**
 * GitHub Copilot upstream rejects `user` strings longer than 64 characters
 * with `invalid_request_body`. Claude Code's `metadata.user_id` (forwarded as
 * `user`) is typically far longer (account+session composite). Truncate to
 * stay within the limit while preserving the prefix, which is generally the
 * stable per-user portion.
 */
export const COPILOT_USER_MAX_LENGTH = 64

export function clampUserField<T extends { user?: string | null }>(
  payload: T,
): T {
  if (typeof payload.user !== "string") return payload
  if (payload.user.length <= COPILOT_USER_MAX_LENGTH) return payload
  return { ...payload, user: payload.user.slice(0, COPILOT_USER_MAX_LENGTH) }
}
