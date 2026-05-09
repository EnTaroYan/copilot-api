import consola from "consola"

import { githubHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { getGithubApiBaseUrl } from "~/lib/runtime-config"
import { state } from "~/lib/state"

export const getCopilotToken = async () => {
  const url = `${getGithubApiBaseUrl()}/copilot_internal/v2/token`
  const response = await fetch(url, {
    headers: githubHeaders(state),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => "<no body>")
    consola.error(
      `GET ${url} -> ${response.status} ${response.statusText}\n${body}`,
    )
    throw new HTTPError("Failed to get Copilot token", response)
  }

  return (await response.json()) as GetCopilotTokenResponse
}

interface GetCopilotTokenResponse {
  expires_at: number
  refresh_in: number
  token: string
  /**
   * Tenant-specific upstream endpoints. GHEC tokens carry a region "stamp"
   * (e.g. `prod-wus3-01`) in the JWT — calling the public
   * `api.githubcopilot.com` returns 400 "unknown stamp", so we must use
   * `endpoints.api` instead. Public github.com tokens may omit this.
   */
  endpoints?: {
    api?: string
    "origin-tracker"?: string
    proxy?: string
    telemetry?: string
  }
}
