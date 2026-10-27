import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFile, spawn } from "node:child_process"

export type QuotaWindow = {
  usedPercent?: number
  windowMinutes?: number
  resetsAt?: number
}

export type QuotaCredits = {
  hasCredits?: boolean
  unlimited?: boolean
  balance?: string | number
}

export type AuthTokens = {
  accessToken: string
  refreshToken: string
  idToken?: string
  accountId?: string
  lastRefresh?: string
}

export type UsageSnapshot = {
  accountId?: string
  planType?: string
  email?: string
  primary?: QuotaWindow
  secondary?: QuotaWindow
  credits?: QuotaCredits
  resetCredits?: number
  ordinaryUsageAllowed?: boolean
  rateLimitReachedType?: string | null
  fetchedAt: number
  source: "http" | "app-server"
}

export const CODEX_HOME = path.join(os.homedir(), ".codex")
export const CODEX_AUTH = path.join(CODEX_HOME, "auth.json")

const CODEX_BIN = process.env.CODEX_CLI_BIN || "codex"
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
const CACHE_FILE = path.join(os.homedir(), ".cache", "opencode", "codex-usage.json")
const HTTP_TIMEOUT_MS = 8_000
const APP_SERVER_TIMEOUT_MS = 12_000
const CACHE_TTL_MS = 60_000
const EXPIRY_SKEW_MS = 60_000
const DEFAULT_CODEX_UA = "codex_cli_rs/0.164.0"

function execFileText(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 2_000, encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

let userAgentPromise: Promise<string> | undefined

/** 跟随本机 codex 版本生成 UA，避免后端校验版本时失效。 */
function codexUserAgent(): Promise<string> {
  const override = process.env.CODEX_CLI_USER_AGENT
  if (override) return Promise.resolve(override)
  userAgentPromise ??= (async () => {
    const version = readJson(path.join(CODEX_HOME, "version.json"))?.latest_version
    if (typeof version === "string" && version) return `codex_cli_rs/${version}`
    try {
      const stdout = await execFileText(CODEX_BIN, ["--version"])
      const match = /(\d+\.\d+\.\d+)/.exec(stdout)
      if (match) return `codex_cli_rs/${match[1]}`
    } catch {
      // 读不到版本就用兜底 UA
    }
    return DEFAULT_CODEX_UA
  })()
  return userAgentPromise
}

export function readJson(file: string): any | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
}

export function decodeJwt(token?: string): any | undefined {
  if (!token) return undefined
  try {
    const part = token.split(".")[1]
    if (!part) return undefined
    const padded = part.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (part.length % 4)) % 4)
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"))
  } catch {
    return undefined
  }
}

function accountIdFromClaims(claims: any): string | undefined {
  if (!claims || typeof claims !== "object") return undefined
  const auth = claims["https://api.openai.com/auth"]
  return auth?.chatgpt_account_id || claims.sub || auth?.user_id || undefined
}

/** 读取 Codex CLI 当前登录的账号 token。 */
export function readCodexAuth(): AuthTokens | undefined {
  const data = readJson(CODEX_AUTH)
  const tokens = data?.tokens || data
  const accessToken = tokens?.access_token || tokens?.accessToken
  const refreshToken = tokens?.refresh_token || tokens?.refreshToken
  if (!accessToken || !refreshToken) return undefined
  const idToken = tokens?.id_token || tokens?.idToken
  return {
    accessToken,
    refreshToken,
    idToken,
    accountId:
      tokens?.account_id || accountIdFromClaims(decodeJwt(accessToken)) || accountIdFromClaims(decodeJwt(idToken)),
    lastRefresh: data?.last_refresh,
  }
}

function isExpiring(token: string, skewMs = EXPIRY_SKEW_MS): boolean {
  const exp = decodeJwt(token)?.exp
  if (typeof exp !== "number") return false
  return exp * 1000 - skewMs <= Date.now()
}

function normalizeWindow(window: any): QuotaWindow | undefined {
  if (!window || typeof window !== "object") return undefined
  const usedPercent = typeof window.used_percent === "number" ? window.used_percent : undefined
  const seconds = typeof window.limit_window_seconds === "number" ? window.limit_window_seconds : undefined
  const resetsAt = typeof window.reset_at === "number" ? window.reset_at : undefined
  if (usedPercent === undefined && seconds === undefined && resetsAt === undefined) return undefined
  return {
    usedPercent,
    windowMinutes: seconds === undefined ? undefined : Math.round(seconds / 60),
    resetsAt,
  }
}

/** 官方 CLI 内部接口：chatgpt.com/backend-api/wham/usage（codex 二进制里同名）。 */
async function fetchHttpUsage(auth: AuthTokens): Promise<UsageSnapshot> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS)
  const headers: Record<string, string> = {
    authorization: `Bearer ${auth.accessToken}`,
    "user-agent": await codexUserAgent(),
    originator: "codex_cli_rs",
    accept: "application/json",
  }
  if (auth.accountId) headers["chatgpt-account-id"] = auth.accountId

  let response: Response
  try {
    response = await fetch(USAGE_URL, { headers, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "")
    const detail = body.trim().slice(0, 160)
    throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ""}`)
  }

  const data = (await response.json()) as any
  const rateLimit = data?.rate_limit || {}
  return {
    accountId: data?.account_id || auth.accountId,
    planType: data?.plan_type,
    email: data?.email,
    primary: normalizeWindow(rateLimit.primary_window),
    secondary: normalizeWindow(rateLimit.secondary_window),
    credits: data?.credits
      ? {
          hasCredits: data.credits.has_credits,
          unlimited: data.credits.unlimited,
          balance: data.credits.balance,
        }
      : undefined,
    resetCredits: data?.rate_limit_reset_credits?.available_count,
    ordinaryUsageAllowed: typeof rateLimit.allowed === "boolean" ? rateLimit.allowed : undefined,
    rateLimitReachedType: data?.rate_limit_reached_type ?? null,
    fetchedAt: Date.now(),
    source: "http",
  }
}

function normalizeAppServerWindow(window: any): QuotaWindow | undefined {
  if (!window || typeof window !== "object") return undefined
  const usedPercent = typeof window.usedPercent === "number" ? window.usedPercent : undefined
  const windowMinutes = typeof window.windowDurationMins === "number" ? window.windowDurationMins : undefined
  const resetsAt = typeof window.resetsAt === "number" ? window.resetsAt : undefined
  if (usedPercent === undefined && windowMinutes === undefined && resetsAt === undefined) return undefined
  return { usedPercent, windowMinutes, resetsAt }
}

function normalizeAppServerResult(payload: any): UsageSnapshot {
  const rateLimits = payload?.rateLimits || payload?.rateLimitsByLimitId?.codex || {}
  return {
    planType: rateLimits?.planType || payload?.planType,
    primary: normalizeAppServerWindow(rateLimits?.primary),
    secondary: normalizeAppServerWindow(rateLimits?.secondary),
    credits: rateLimits?.credits
      ? {
          hasCredits: rateLimits.credits.hasCredits,
          unlimited: rateLimits.credits.unlimited,
          balance: rateLimits.credits.balance,
        }
      : undefined,
    resetCredits: payload?.rateLimitResetCredits?.availableCount,
    ordinaryUsageAllowed: payload?.ordinaryUsageAllowed,
    rateLimitReachedType: rateLimits?.rateLimitReachedType ?? null,
    fetchedAt: Date.now(),
    source: "app-server",
  }
}

/**
 * 用 codex app-server 读取额度。
 * useDefaultHome=true 时使用真实 ~/.codex，token 过期会由 codex 自行刷新并写回；
 * 否则把凭据写进临时 CODEX_HOME，避免影响当前登录。
 */
async function fetchAppServerUsage(auth: AuthTokens, useDefaultHome: boolean): Promise<UsageSnapshot> {
  let tempHome: string | undefined
  if (!useDefaultHome) {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-codex-usage-"))
    fs.writeFileSync(
      path.join(tempHome, "auth.json"),
      JSON.stringify({
        OPENAI_API_KEY: null,
        auth_mode: "chatgpt",
        tokens: {
          access_token: auth.accessToken,
          refresh_token: auth.refreshToken,
          id_token: auth.idToken || auth.accessToken,
          account_id: auth.accountId || "",
        },
        last_refresh: auth.lastRefresh || new Date().toISOString(),
      }),
      { mode: 0o600 },
    )
  }

  const child = spawn(CODEX_BIN, ["app-server", "--listen", "stdio://"], {
    env: { ...process.env, ...(tempHome ? { CODEX_HOME: tempHome } : {}) },
    stdio: ["pipe", "pipe", "pipe"],
  })

  try {
    return await new Promise<UsageSnapshot>((resolve, reject) => {
      let buffer = ""
      let stderr = ""
      let settled = false

      const finish = (err?: Error, value?: UsageSnapshot) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (err) reject(err)
        else resolve(value as UsageSnapshot)
      }

      const timer = setTimeout(() => finish(new Error("codex app-server 超时")), APP_SERVER_TIMEOUT_MS)

      child.stdout.setEncoding("utf8")
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk
        let newline = buffer.indexOf("\n")
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          newline = buffer.indexOf("\n")
          if (!line) continue
          let message: any
          try {
            message = JSON.parse(line)
          } catch {
            continue
          }
          if (message.id !== 2) continue
          if (message.error) {
            finish(new Error(message.error.message || "读取 Codex 额度失败"))
          } else {
            finish(undefined, normalizeAppServerResult(message.result))
          }
        }
      })

      child.stderr.setEncoding("utf8")
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk
        if (stderr.length > 2000) stderr = stderr.slice(-2000)
      })

      child.on("error", (err) => finish(err instanceof Error ? err : new Error(String(err))))
      child.on("exit", (code) => {
        if (!settled) {
          finish(new Error(`codex app-server 退出 (${code ?? "?"})${stderr ? `: ${stderr.slice(-300)}` : ""}`))
        }
      })

      const send = (message: any) => child.stdin.write(JSON.stringify(message) + "\n")
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "opencode-codex-usage", version: "0.2.0" } },
      })
      send({ jsonrpc: "2.0", method: "initialized", params: {} })
      send({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: {} })
    })
  } finally {
    child.kill()
    if (tempHome) fs.rmSync(tempHome, { recursive: true, force: true })
  }
}

/**
 * 先走 HTTP（约 200ms），token 将过期/401/网络失败时回退 app-server（顺带刷新 token）。
 */
export async function fetchUsage(
  auth: AuthTokens,
  options: { allowAppServer?: boolean; useDefaultHome?: boolean } = {},
): Promise<UsageSnapshot> {
  const allowAppServer = options.allowAppServer !== false
  const useDefaultHome = options.useDefaultHome !== false

  if (!isExpiring(auth.accessToken)) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await fetchHttpUsage(auth)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // 401/403 是凭据问题，重试没有意义；网络/5xx 再试一次。
        if (/^HTTP 40[13]/.test(message) || attempt === 1 || !allowAppServer) {
          if (!allowAppServer) throw error
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 300))
      }
    }
  }

  if (!allowAppServer) throw new Error("Codex token 即将过期，且未启用 app-server 回退")
  return fetchAppServerUsage(auth, useDefaultHome)
}

let cached: { value: UsageSnapshot; at: number } | undefined
let inflight: Promise<UsageSnapshot> | undefined

export function peekCachedUsage(): UsageSnapshot | undefined {
  return cached?.value
}

/** 上次成功读取的结果，用于 TUI 冷启动时先显示旧值。 */
export function loadCachedUsage(): UsageSnapshot | undefined {
  const data = readJson(CACHE_FILE)
  if (!data || typeof data !== "object" || typeof data.fetchedAt !== "number") return undefined
  return data as UsageSnapshot
}

function saveCachedUsage(snapshot: UsageSnapshot): void {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true })
    fs.writeFileSync(CACHE_FILE, JSON.stringify(snapshot), { mode: 0o600 })
  } catch {
    // 缓存写失败不影响读取
  }
}

/** Codex CLI 当前账号的额度，默认 60s 进程内缓存。 */
export async function getCurrentUsage(options: { force?: boolean } = {}): Promise<UsageSnapshot> {
  if (!options.force && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value
  if (inflight) return inflight

  inflight = (async () => {
    const auth = readCodexAuth()
    if (!auth) throw new Error("未找到 ~/.codex/auth.json，请先登录 Codex CLI")
    const value = await fetchUsage(auth, { useDefaultHome: true })
    cached = { value, at: Date.now() }
    saveCachedUsage(value)
    return value
  })().finally(() => {
    inflight = undefined
  })

  return inflight
}

export function clearUsageCache(): void {
  cached = undefined
}
