#!/usr/bin/env node

import { defineCommand } from "citty"
import consola from "consola"

import { PATHS, ensurePaths, refreshPaths } from "./lib/paths"
import { setRuntimeConfig } from "./lib/runtime-config"
import { state } from "./lib/state"
import { setupGitHubToken } from "./lib/token"

interface RunAuthOptions {
  verbose: boolean
  showToken: boolean
  githubBaseUrl?: string
  home?: string
}

export async function runAuth(options: RunAuthOptions): Promise<void> {
  if (options.verbose) {
    consola.level = 5
    consola.info("Verbose logging enabled")
  }

  state.showToken = options.showToken

  setRuntimeConfig({
    githubBaseUrl: options.githubBaseUrl,
    homePath: options.home,
  })
  refreshPaths()
  if (options.githubBaseUrl) {
    consola.info(`Using GitHub base URL: ${options.githubBaseUrl}`)
  }
  if (options.home) {
    consola.info(`Using copilot-api home: ${options.home}`)
  }

  await ensurePaths()
  await setupGitHubToken({ force: true })
  consola.success("GitHub token written to", PATHS.GITHUB_TOKEN_PATH)
}

export const auth = defineCommand({
  meta: {
    name: "auth",
    description: "Run GitHub auth flow without running the server",
  },
  args: {
    verbose: {
      alias: "v",
      type: "boolean",
      default: false,
      description: "Enable verbose logging",
    },
    "show-token": {
      type: "boolean",
      default: false,
      description: "Show GitHub token on auth",
    },
    "github-base-url": {
      type: "string",
      description:
        "Override GitHub base URL for OAuth (default: https://github.com). "
        + "Use e.g. https://acme.ghe.com for GHEC data residency. "
        + "Env: COPILOT_API_GITHUB_BASE_URL",
    },
    home: {
      type: "string",
      description:
        "Override the home directory used to store the GitHub token "
        + "(<home>/.local/share/copilot-api). Env: COPILOT_API_HOME",
    },
  },
  run({ args }) {
    return runAuth({
      verbose: args.verbose,
      showToken: args["show-token"],
      githubBaseUrl:
        (args["github-base-url"] as string | undefined)
        ?? process.env.COPILOT_API_GITHUB_BASE_URL,
      home: (args.home as string | undefined) ?? process.env.COPILOT_API_HOME,
    })
  },
})
