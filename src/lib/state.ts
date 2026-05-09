import type { ModelsResponse } from "~/services/copilot/get-models"

export interface State {
  githubToken?: string
  copilotToken?: string
  /**
   * Upstream Copilot API base URL learned from the token response
   * (`endpoints.api`). Required for GHEC tokens whose region "stamp" is not
   * recognized by the public `api.githubcopilot.com` host. Falls back to
   * account-type derivation when absent.
   */
  copilotApiEndpoint?: string

  accountType: string
  models?: ModelsResponse
  vsCodeVersion?: string
  copilotChatVersion?: string

  manualApprove: boolean
  rateLimitWait: boolean
  showToken: boolean

  // Rate limiting configuration
  rateLimitSeconds?: number
  lastRequestTimestamp?: number
}

export const state: State = {
  accountType: "individual",
  manualApprove: false,
  rateLimitWait: false,
  showToken: false,
}
