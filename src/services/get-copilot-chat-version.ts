const FALLBACK = "0.45.1"

const MARKETPLACE_URL =
  "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery"

const EXTENSION_ID = "GitHub.copilot-chat"

interface MarketplaceVersion {
  version?: string
  properties?: Array<{ key?: string; value?: string }>
}

interface MarketplaceExtension {
  versions?: Array<MarketplaceVersion>
}

interface MarketplaceResponse {
  results?: Array<{ extensions?: Array<MarketplaceExtension> }>
}

const isPreRelease = (v: MarketplaceVersion): boolean =>
  (v.properties ?? []).some(
    (p) =>
      p.key === "Microsoft.VisualStudio.Code.PreRelease" && p.value === "true",
  )

export async function getCopilotChatVersion(): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort()
  }, 5000)

  try {
    const response = await fetch(MARKETPLACE_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Accept: "application/json;api-version=3.0-preview.1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filters: [
          {
            criteria: [{ filterType: 7, value: EXTENSION_ID }],
          },
        ],
        // 0x100 IncludeLatestVersionOnly | 0x80 IncludeStatistics
        // | 0x10 IncludeVersionProperties | 0x2 IncludeFiles
        flags: 914,
      }),
    })

    if (!response.ok) return FALLBACK

    const data = (await response.json()) as MarketplaceResponse
    const versions = data.results?.[0]?.extensions?.[0]?.versions ?? []

    const stable = versions.find((v) => v.version && !isPreRelease(v))
    if (stable?.version) return stable.version

    return FALLBACK
  } catch {
    return FALLBACK
  } finally {
    clearTimeout(timeout)
  }
}
