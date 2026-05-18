const FALLBACK = "1.119.0"

// Official VSCode auto-update endpoint. Sending a sentinel zero-SHA as
// "currently installed commit" makes the server respond with the latest
// release metadata regardless of what we have. Replaces the AUR PKGBUILD
// source which lagged 3+ versions behind.
const UPDATE_URL =
  "https://update.code.visualstudio.com/api/update/linux-x64/stable/0000000000000000000000000000000000000000"

interface UpdateResponse {
  productVersion?: string
  name?: string
  version?: string
}

export async function getVSCodeVersion() {
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort()
  }, 5000)

  try {
    const response = await fetch(UPDATE_URL, { signal: controller.signal })
    if (!response.ok) return FALLBACK
    const data = (await response.json()) as UpdateResponse
    return data.productVersion ?? data.name ?? FALLBACK
  } catch {
    return FALLBACK
  } finally {
    clearTimeout(timeout)
  }
}

await getVSCodeVersion()
