import os from "node:os"

interface RuntimeConfig {
  /**
   * Base URL of the GitHub instance used for OAuth device-flow and REST.
   * Defaults to the public github.com. For GHEC data residency tenants set
   * to e.g. `https://acme.ghe.com`. The companion API base URL is derived
   * by prefixing the host with `api.` (which works for both github.com and
   * `*.ghe.com`).
   */
  githubBaseUrl: string

  /**
   * Directory used to derive the per-instance APP_DIR
   * (`<homePath>/.local/share/copilot-api`). Defaults to `os.homedir()`.
   * Override to run multiple instances against different GitHub accounts
   * without sharing the same on-disk token file.
   */
  homePath: string
}

const config: RuntimeConfig = {
  githubBaseUrl: "https://github.com",
  homePath: os.homedir(),
}

export function setRuntimeConfig(overrides: Partial<RuntimeConfig>): void {
  if (overrides.githubBaseUrl !== undefined) {
    // Strip a trailing slash to keep concatenation predictable.
    config.githubBaseUrl = overrides.githubBaseUrl.replace(/\/+$/, "")
  }
  if (overrides.homePath !== undefined) {
    config.homePath = overrides.homePath
  }
}

export function getGithubBaseUrl(): string {
  return config.githubBaseUrl
}

/**
 * Derive the REST API base URL from `githubBaseUrl` by prepending `api.` to
 * the host. Works for both `github.com → api.github.com` and
 * `acme.ghe.com → api.acme.ghe.com`.
 */
export function getGithubApiBaseUrl(): string {
  const url = new URL(config.githubBaseUrl)
  url.host = `api.${url.host}`
  // URL keeps a trailing slash on origin-only URLs; normalize.
  return url.origin
}

export function getHomePath(): string {
  return config.homePath
}
