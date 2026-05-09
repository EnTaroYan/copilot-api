import consola from "consola"
import fsSync from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"

import { getHomePath } from "~/lib/runtime-config"

function computePaths(home: string) {
  const APP_DIR = path.join(home, ".local", "share", "copilot-api")
  return {
    APP_DIR,
    GITHUB_TOKEN_PATH: path.join(APP_DIR, "github_token"),
    INSTANCE_LOCK_PATH: path.join(APP_DIR, "instance.lock"),
  }
}

// Mutable in place so existing `import { PATHS }` consumers see updates after
// `refreshPaths()` runs at startup. (ESM live-bindings would also work for
// `let` exports, but in-place mutation is more portable across bundlers.)
export const PATHS: ReturnType<typeof computePaths> =
  computePaths(getHomePath())

export function refreshPaths(): void {
  const next = computePaths(getHomePath())
  PATHS.APP_DIR = next.APP_DIR
  PATHS.GITHUB_TOKEN_PATH = next.GITHUB_TOKEN_PATH
  PATHS.INSTANCE_LOCK_PATH = next.INSTANCE_LOCK_PATH
}

export async function ensurePaths(): Promise<void> {
  await fs.mkdir(PATHS.APP_DIR, { recursive: true })
  await ensureFile(PATHS.GITHUB_TOKEN_PATH)
}

async function ensureFile(filePath: string): Promise<void> {
  try {
    await fs.access(filePath, fs.constants.W_OK)
  } catch {
    await fs.writeFile(filePath, "")
    await fs.chmod(filePath, 0o600)
  }
}

let lockReleased = false

/**
 * Prevent two `start` instances from sharing the same on-disk APP_DIR (which
 * would silently make them use the same GitHub account, defeating the point
 * of running a multi-account pool). Writes a PID lockfile under APP_DIR; if
 * one already exists with a live PID we abort with a helpful error. Stale
 * locks (PID no longer running) are overwritten transparently.
 *
 * Pass `force` to bypass the check (useful if a previous instance died with
 * SIGKILL and the heuristic is wrong somehow).
 */
export async function acquireInstanceLock(
  options: { force?: boolean } = {},
): Promise<void> {
  try {
    const raw = await fs.readFile(PATHS.INSTANCE_LOCK_PATH, "utf8")
    const existingPid = Number.parseInt(raw.trim(), 10)
    if (!options.force && Number.isFinite(existingPid) && existingPid > 0) {
      const alive = isPidAlive(existingPid)
      if (alive) {
        throw new Error(
          `Another copilot-api instance (PID ${existingPid}) is already `
            + `using --home "${getHomePath()}" `
            + `(lockfile: ${PATHS.INSTANCE_LOCK_PATH}). `
            + "Use a different --home for each pool member, stop the other "
            + "instance, or pass --force to override.",
        )
      }
      consola.warn(
        `Stale instance lock for dead PID ${existingPid} found at `
          + `${PATHS.INSTANCE_LOCK_PATH}; overwriting.`,
      )
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }

  await fs.writeFile(PATHS.INSTANCE_LOCK_PATH, `${process.pid}\n`)

  const release = () => {
    if (lockReleased) return
    lockReleased = true
    try {
      // Best-effort: only delete the lock if it's still ours. Avoids racing
      // with a later instance that may have taken over after a stale read.
      const raw = fsSync.readFileSync(PATHS.INSTANCE_LOCK_PATH, "utf8")
      if (Number.parseInt(raw.trim(), 10) === process.pid) {
        fsSync.unlinkSync(PATHS.INSTANCE_LOCK_PATH)
      }
    } catch {
      // ignore
    }
  }

  process.once("exit", release)
  process.once("SIGINT", () => {
    release()
    process.exit(130)
  })
  process.once("SIGTERM", () => {
    release()
    process.exit(143)
  })
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but we lack permission to signal it —
    // still alive for our purposes.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}
