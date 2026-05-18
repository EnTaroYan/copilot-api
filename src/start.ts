#!/usr/bin/env node

import { defineCommand } from "citty"
import clipboard from "clipboardy"
import consola from "consola"
import { serve, type ServerHandler } from "srvx"
import invariant from "tiny-invariant"

import { acquireInstanceLock, ensurePaths, refreshPaths } from "./lib/paths"
import { initProxyFromEnv } from "./lib/proxy"
import { setRuntimeConfig } from "./lib/runtime-config"
import { generateEnvScript } from "./lib/shell"
import { state } from "./lib/state"
import { setupCopilotToken, setupGitHubToken } from "./lib/token"
import {
  cacheCopilotChatVersion,
  cacheModels,
  cacheVSCodeVersion,
} from "./lib/utils"
import { server } from "./server"

const formatModelMultiplier = (model: {
  billing?: { multiplier?: number }
}): string => {
  const m = model.billing?.multiplier
  if (m === undefined) return ""
  if (m === 0) return " (free)"
  return ` (${m}x)`
}

// Periodic background refresh of the model list. Without this,
// newly-added upstream models or billing/multiplier changes are only
// picked up on restart. 2h matches the proxy-side cache TTL.
const MODELS_REFRESH_INTERVAL_MS = 2 * 60 * 60 * 1000

function scheduleModelsRefresh(): void {
  const timer = setInterval(() => {
    void cacheModels().catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e)
      consola.warn(`Background models refresh failed: ${msg}`)
    })
  }, MODELS_REFRESH_INTERVAL_MS)
  // Don't keep the process alive just for this refresh tick.
  ;(timer as { unref?: () => void }).unref?.()
}

interface RunServerOptions {
  port: number
  verbose: boolean
  accountType: string
  manual: boolean
  rateLimit?: number
  rateLimitWait: boolean
  githubToken?: string
  claudeCode: boolean
  showToken: boolean
  proxyEnv: boolean
  githubBaseUrl?: string
  home?: string
  force?: boolean
}

export async function runServer(options: RunServerOptions): Promise<void> {
  if (options.proxyEnv) {
    initProxyFromEnv()
  }

  if (options.verbose) {
    consola.level = 5
    consola.info("Verbose logging enabled")
  }

  // Apply runtime overrides BEFORE any path computation or GitHub call so
  // that token storage and OAuth endpoints both pick up the new home /
  // GitHub base URL on this very request path.
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

  state.accountType = options.accountType
  if (options.accountType !== "individual") {
    consola.info(`Using ${options.accountType} plan GitHub account`)
  }

  state.manualApprove = options.manual
  state.rateLimitSeconds = options.rateLimit
  state.rateLimitWait = options.rateLimitWait
  state.showToken = options.showToken

  await ensurePaths()
  await acquireInstanceLock({ force: options.force })
  await Promise.all([cacheVSCodeVersion(), cacheCopilotChatVersion()])

  if (options.githubToken) {
    state.githubToken = options.githubToken
    consola.info("Using provided GitHub token")
  } else {
    await setupGitHubToken()
  }

  await setupCopilotToken()
  await cacheModels()
  scheduleModelsRefresh()

  consola.info(
    `Available models: \n${state.models?.data
      .map((model) => `- ${model.id}${formatModelMultiplier(model)}`)
      .join("\n")}`,
  )

  const serverUrl = `http://localhost:${options.port}`

  if (options.claudeCode) {
    invariant(state.models, "Models should be loaded by now")

    const selectedModel = await consola.prompt(
      "Select a model to use with Claude Code",
      {
        type: "select",
        options: state.models.data.map((model) => model.id),
      },
    )

    const selectedSmallModel = await consola.prompt(
      "Select a small model to use with Claude Code",
      {
        type: "select",
        options: state.models.data.map((model) => model.id),
      },
    )

    const command = generateEnvScript(
      {
        ANTHROPIC_BASE_URL: serverUrl,
        ANTHROPIC_AUTH_TOKEN: "dummy",
        ANTHROPIC_MODEL: selectedModel,
        ANTHROPIC_DEFAULT_SONNET_MODEL: selectedModel,
        ANTHROPIC_SMALL_FAST_MODEL: selectedSmallModel,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: selectedSmallModel,
        DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
      "claude",
    )

    try {
      clipboard.writeSync(command)
      consola.success("Copied Claude Code command to clipboard!")
    } catch {
      consola.warn(
        "Failed to copy to clipboard. Here is the Claude Code command:",
      )
      consola.log(command)
    }
  }

  consola.box(
    `🌐 Usage Viewer: https://ericc-ch.github.io/copilot-api?endpoint=${serverUrl}/usage`,
  )

  serve({
    fetch: server.fetch as ServerHandler,
    port: options.port,
    bun: { idleTimeout: 255 },
  })
}

export const start = defineCommand({
  meta: {
    name: "start",
    description: "Start the Copilot API server",
  },
  args: {
    port: {
      alias: "p",
      type: "string",
      default: "4141",
      description: "Port to listen on",
    },
    verbose: {
      alias: "v",
      type: "boolean",
      default: false,
      description: "Enable verbose logging",
    },
    "account-type": {
      alias: "a",
      type: "string",
      default: "individual",
      description: "Account type to use (individual, business, enterprise)",
    },
    manual: {
      type: "boolean",
      default: false,
      description: "Enable manual request approval",
    },
    "rate-limit": {
      alias: "r",
      type: "string",
      description: "Rate limit in seconds between requests",
    },
    wait: {
      alias: "w",
      type: "boolean",
      default: false,
      description:
        "Wait instead of error when rate limit is hit. Has no effect if rate limit is not set",
    },
    "github-token": {
      alias: "g",
      type: "string",
      description:
        "Provide GitHub token directly (must be generated using the `auth` subcommand)",
    },
    "claude-code": {
      alias: "c",
      type: "boolean",
      default: false,
      description:
        "Generate a command to launch Claude Code with Copilot API config",
    },
    "show-token": {
      type: "boolean",
      default: false,
      description: "Show GitHub and Copilot tokens on fetch and refresh",
    },
    "proxy-env": {
      type: "boolean",
      default: false,
      description: "Initialize proxy from environment variables",
    },
    "github-base-url": {
      type: "string",
      description:
        "Override GitHub base URL for OAuth + REST (default: https://github.com). "
        + "API base URL is derived by prefixing the host with `api.` so "
        + "`https://acme.ghe.com` becomes `https://api.acme.ghe.com`. "
        + "Env: COPILOT_API_GITHUB_BASE_URL",
    },
    home: {
      type: "string",
      description:
        "Override the home directory used to derive the on-disk APP_DIR "
        + "(<home>/.local/share/copilot-api). Use a unique value per pool "
        + "instance to keep GitHub tokens isolated. Env: COPILOT_API_HOME",
    },
    force: {
      type: "boolean",
      default: false,
      description:
        "Bypass the per-home instance lock check (use only if you know the "
        + "previous instance is dead but the lockfile wasn't cleaned up).",
    },
  },
  run({ args }) {
    const rateLimitRaw = args["rate-limit"]
    const rateLimit =
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      rateLimitRaw === undefined ? undefined : Number.parseInt(rateLimitRaw, 10)

    return runServer({
      port: Number.parseInt(args.port, 10),
      verbose: args.verbose,
      accountType: args["account-type"],
      manual: args.manual,
      rateLimit,
      rateLimitWait: args.wait,
      githubToken: args["github-token"],
      claudeCode: args["claude-code"],
      showToken: args["show-token"],
      proxyEnv: args["proxy-env"],
      githubBaseUrl:
        (args["github-base-url"] as string | undefined)
        ?? process.env.COPILOT_API_GITHUB_BASE_URL,
      home: (args.home as string | undefined) ?? process.env.COPILOT_API_HOME,
      force: args.force,
    })
  },
})
