import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  CODEX_HOME,
  decodeJwt,
  fetchUsage,
  readCodexAuth,
  readJson,
  type QuotaCredits,
  type QuotaWindow,
} from "./quota-api"

export type { QuotaCredits, QuotaWindow } from "./quota-api"

export type QuotaRow = {
  accountId: string
  labels: string[]
  active?: boolean
  planType?: string
  primary?: QuotaWindow
  secondary?: QuotaWindow
  credits?: QuotaCredits
  resetCredits?: number
  ordinaryUsageAllowed?: boolean
  rateLimitReachedType?: string | null
  cached?: boolean
  cachedAt?: number
  error?: string
}

export type OpenAIConnectionRow = {
  id: string
  label: string
  active: boolean
  accountId?: string
  planType?: string
  methodID?: string
  /** chatgpt = 带 account claim 的 ChatGPT 登录；other = 其他认证方式 */
  kind?: "chatgpt" | "other" | "unknown"
  expired?: boolean
  matchedLabel?: string
  error?: string
}

export type UsageReport = {
  rows: QuotaRow[]
  connections: OpenAIConnectionRow[]
  notes: string[]
  generatedAt: number
}

type AuthTokens = {
  accessToken: string
  refreshToken: string
  idToken?: string
  accountId?: string
  lastRefresh?: string
}

type Ctx = {
  integration?: {
    get(input: { integrationID: string }): Promise<any>
    connection: {
      active(integrationID: string): Promise<any>
      resolve(connection: any): Promise<any>
    }
  }
}

const MULTI_STORE = path.join(os.homedir(), ".config", "opencode-multi-auth", "accounts.json")
const OPENCODE_DATA = path.join(os.homedir(), ".local", "share", "opencode")
const OPENCODE_DB = path.join(OPENCODE_DATA, "opencode.db")
const OPENCODE_AUTH = path.join(OPENCODE_DATA, "auth.json")

function accountIdFromClaims(claims: any): string | undefined {
  if (!claims || typeof claims !== "object") return undefined
  const auth = claims["https://api.openai.com/auth"]
  return auth?.chatgpt_account_id || claims.sub || auth?.user_id || undefined
}

/** 只有 ChatGPT 登录态才带 chatgpt_account_id；令牌共享/API key 类连接没有。 */
function chatgptAccountIdFromClaims(claims: any): string | undefined {
  if (!claims || typeof claims !== "object") return undefined
  return claims["https://api.openai.com/auth"]?.chatgpt_account_id || undefined
}

function planTypeFromClaims(claims: any): string | undefined {
  if (!claims || typeof claims !== "object") return undefined
  return claims["https://api.openai.com/auth"]?.chatgpt_plan_type || undefined
}

type StoredCredential = {
  access?: string
  refresh?: string
  expires?: number
  methodID?: string
  type?: string
}

/**
 * 读取 OpenCode 本地已存的 OpenAI 凭据。
 * 优先按 connection.id 精确查询凭据库（只读），失败时退回旧版 auth.json。
 * 这样即使 resolve 因 token 过期而 401，仍然能确认这条连接属于哪个账号。
 */
async function readStoredCredential(id?: string, allowLegacy = true): Promise<StoredCredential | undefined> {
  if (id) {
    let db: any
    try {
      const sqlite: any = await import("bun:sqlite").catch(() => undefined)
      if (sqlite?.Database) {
        db = new sqlite.Database(OPENCODE_DB, { readonly: true })
        const row = db.query("SELECT value FROM credential WHERE id = ?").get(id)
        if (row?.value) {
          const parsed = JSON.parse(row.value)
          if (parsed && typeof parsed === "object") return parsed as StoredCredential
        }
      }
    } catch {
      // 凭据库不可读时继续尝试 auth.json
    } finally {
      try {
        db?.close()
      } catch {
        // ignore
      }
    }
  }

  if (!allowLegacy) return undefined
  const legacy = readJson(OPENCODE_AUTH)?.openai
  if (legacy && typeof legacy === "object") return legacy as StoredCredential
  return undefined
}

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\s+/g, " ").slice(0, 300)
}

function listJsonlFiles(dir: string, depth = 0): string[] {
  if (depth > 6) return []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const files: string[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...listJsonlFiles(full, depth + 1))
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(full)
  }
  return files
}

function latestCodexSessionLimits(): { primary?: QuotaWindow; secondary?: QuotaWindow; cachedAt?: number } | undefined {
  const files = listJsonlFiles(path.join(CODEX_HOME, "sessions"))
    .map((file) => {
      try {
        return { file, mtime: fs.statSync(file).mtimeMs }
      } catch {
        return undefined
      }
    })
    .filter((item): item is { file: string; mtime: number } => Boolean(item))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 20)

  for (const { file } of files) {
    let lines: string[]
    try {
      lines = fs.readFileSync(file, "utf8").split("\n")
    } catch {
      continue
    }
    for (let index = lines.length - 1; index >= 0; index--) {
      let event: any
      try {
        event = JSON.parse(lines[index])
      } catch {
        continue
      }
      if (event?.payload?.type !== "token_count") continue
      const rateLimits = event.payload.rate_limits
      if (!rateLimits) continue
      const toWindow = (window: any): QuotaWindow | undefined => {
        if (!window) return undefined
        return {
          usedPercent: typeof window.used_percent === "number" ? window.used_percent : undefined,
          windowMinutes: typeof window.window_minutes === "number" ? window.window_minutes : undefined,
          resetsAt: typeof window.resets_at === "number" ? window.resets_at : undefined,
        }
      }
      let primary = toWindow(rateLimits.primary)
      let secondary = toWindow(rateLimits.secondary)
      if (primary?.windowMinutes && primary.windowMinutes >= 1000) {
        const swap = primary
        primary = secondary
        secondary = swap
      }
      const parsedAt = Date.parse(event.timestamp)
      return { primary, secondary, cachedAt: Number.isFinite(parsedAt) ? parsedAt : undefined }
    }
  }
  return undefined
}

function cachedWindows(account: any): { primary?: QuotaWindow; secondary?: QuotaWindow } {
  const toWindow = (window: any): QuotaWindow | undefined => {
    if (!window) return undefined
    return {
      usedPercent:
        typeof window.remaining === "number" ? Math.max(0, Math.min(100, 100 - window.remaining)) : undefined,
      resetsAt: typeof window.resetAt === "number" ? Math.round(window.resetAt / 1000) : undefined,
    }
  }
  return {
    primary: toWindow(account?.rateLimits?.fiveHour),
    secondary: toWindow(account?.rateLimits?.weekly),
  }
}

function mergeRow(rows: Map<string, QuotaRow>, accountId: string, label: string, data: Partial<QuotaRow>) {
  let row = rows.get(accountId)
  if (!row) {
    row = { accountId, labels: [] }
    rows.set(accountId, row)
  }
  if (!row.labels.includes(label)) row.labels.push(label)
  if (data.primary && !row.primary) row.primary = data.primary
  if (data.secondary && !row.secondary) row.secondary = data.secondary
  if (data.planType && !row.planType) row.planType = data.planType
  if (data.credits && !row.credits) row.credits = data.credits
  if (typeof data.resetCredits === "number" && row.resetCredits === undefined) row.resetCredits = data.resetCredits
  if (typeof data.ordinaryUsageAllowed === "boolean" && row.ordinaryUsageAllowed === undefined) {
    row.ordinaryUsageAllowed = data.ordinaryUsageAllowed
  }
  if (data.rateLimitReachedType !== undefined && row.rateLimitReachedType === undefined) {
    row.rateLimitReachedType = data.rateLimitReachedType
  }
  if (data.active) row.active = true
  if ((data.primary || data.secondary) && !data.cached) {
    row.cached = false
    row.cachedAt = undefined
    row.error = undefined
  }
  if (data.cached && !row.cached && !row.primary && !row.secondary) {
    row.cached = true
    row.cachedAt = data.cachedAt
  }
  if (data.error && !row.error && !row.primary && !row.secondary) row.error = data.error
}

export async function buildReport(ctx?: Ctx): Promise<UsageReport> {
  const rows = new Map<string, QuotaRow>()
  const notes: string[] = []

  const cliAuth = readCodexAuth()
  if (cliAuth) {
    const accountId = cliAuth.accountId || "codex-cli"
    try {
      const result = await fetchUsage(cliAuth, { useDefaultHome: true })
      mergeRow(rows, accountId, "Codex CLI", result)
    } catch (error) {
      const cached = latestCodexSessionLimits()
      if (cached) {
        mergeRow(rows, accountId, "Codex CLI", {
          ...cached,
          cached: true,
          cachedAt: cached.cachedAt,
          error: shortError(error),
        })
      } else {
        mergeRow(rows, accountId, "Codex CLI", { error: shortError(error) })
      }
    }
  } else {
    notes.push("未找到 ~/.codex/auth.json，Codex CLI 账号未显示。")
  }

  const store = readJson(MULTI_STORE)
  if (store?.accounts && typeof store.accounts === "object") {
    const groups = new Map<
      string,
      { labels: string[]; auth?: AuthTokens; cachedAccount?: any }
    >()

    for (const [alias, account] of Object.entries<any>(store.accounts)) {
      const accountId =
        account?.accountId || accountIdFromClaims(decodeJwt(account?.accessToken)) || account?.email || alias
      let group = groups.get(accountId)
      if (!group) {
        group = { labels: [] }
        groups.set(accountId, group)
      }
      group.labels.push(`multi-auth:${alias}`)
      const hasTokens = Boolean(account?.accessToken && account?.refreshToken)
      if (hasTokens && (!group.auth || account?.enabled !== false)) {
        group.auth = {
          accessToken: account.accessToken,
          refreshToken: account.refreshToken,
          idToken: account.idToken,
          accountId,
          lastRefresh: account.lastRefresh,
        }
      }
      if (account?.enabled !== false || !group.cachedAccount) {
        group.cachedAccount = account
      }
    }

    for (const [accountId, group] of groups) {
      const label = group.labels.join(" / ")
      const existing = rows.get(accountId)
      if (existing && (existing.primary || existing.secondary)) {
        // 同一账号已经从 Codex CLI 读到实时额度，不再重复请求。
        mergeRow(rows, accountId, label, {})
        continue
      }
      if (group.auth) {
        try {
          const result = await fetchUsage(group.auth, { useDefaultHome: false })
          mergeRow(rows, accountId, label, result)
        } catch (error) {
          const cached = cachedWindows(group.cachedAccount)
          mergeRow(rows, accountId, label, {
            ...cached,
            credits: group.cachedAccount?.credits
              ? {
                  hasCredits: group.cachedAccount.credits.hasCredits,
                  unlimited: group.cachedAccount.credits.unlimited,
                  balance: group.cachedAccount.credits.balance,
                }
              : undefined,
            cached: true,
            cachedAt: group.cachedAccount?.rateLimits?.fiveHour?.updatedAt,
            error: shortError(error),
          })
        }
      } else {
        const cached = cachedWindows(group.cachedAccount)
        mergeRow(rows, accountId, label, {
          ...cached,
          credits: group.cachedAccount?.credits
            ? {
                hasCredits: group.cachedAccount.credits.hasCredits,
                unlimited: group.cachedAccount.credits.unlimited,
                balance: group.cachedAccount.credits.balance,
              }
            : undefined,
          cached: true,
          cachedAt: group.cachedAccount?.rateLimits?.fiveHour?.updatedAt,
        })
      }
    }
  }

  const connections: OpenAIConnectionRow[] = []
  if (ctx?.integration?.get) {
    try {
      const response = await ctx.integration.get({ integrationID: "openai" })
      const info = response?.data ?? response
      let activeId: string | undefined
      try {
        const active = await ctx.integration.connection.active("openai")
        activeId = active?.id
      } catch {
        // The active connection is optional information.
      }

      for (const connection of info?.connections || []) {
        const label = connection?.label || connection?.id || "OpenAI"
        let accountId: string | undefined
        let planType: string | undefined
        let methodID: string | undefined
        let expired = false
        let error: string | undefined

        try {
          const credential = await ctx.integration.connection.resolve(connection)
          const claims = decodeJwt(credential?.access)
          accountId = chatgptAccountIdFromClaims(claims)
          planType = planTypeFromClaims(claims)
        } catch (err) {
          error = shortError(err)
        }

        // resolve 失败（常见于 refresh 401）时，用本地已存的 token 识别这条连接属于哪个账号。
        if (!accountId) {
          const stored = await readStoredCredential(connection?.id, Boolean(error))
          const claims = decodeJwt(stored?.access)
          const storedAccountId = chatgptAccountIdFromClaims(claims)
          methodID = stored?.methodID
          if (storedAccountId) {
            accountId = storedAccountId
            planType = planType || planTypeFromClaims(claims)
            expired = typeof stored?.expires === "number" ? stored.expires < Date.now() : false
          }
        }

        const row = accountId ? rows.get(accountId) : undefined
        connections.push({
          id: connection?.id || label,
          label,
          active: Boolean(activeId && connection?.id === activeId),
          accountId,
          planType,
          methodID,
          kind: accountId ? "chatgpt" : methodID ? "other" : "unknown",
          expired,
          matchedLabel: error ? undefined : row?.labels.join(" / "),
          error,
        })
      }

      for (const connection of connections) {
        if (!connection.error || !connection.accountId) continue
        const row = rows.get(connection.accountId)
        if (!row) continue
        const plan = connection.planType ? ` · ${connection.planType}` : ""
        notes.push(
          `${connection.label} 连接与 ${row.labels.join(" / ")} 是同一账号（${shortAccountId(connection.accountId)}${plan}），但本地凭据读取失败；需要时重新 /connect。`,
        )
      }
    } catch (error) {
      notes.push(`读取 OpenCode OpenAI 连接失败：${shortError(error)}`)
    }
  }

  return { rows: Array.from(rows.values()), connections, notes, generatedAt: Date.now() }
}

function formatTime(epochSeconds?: number): string | undefined {
  if (typeof epochSeconds !== "number" || !Number.isFinite(epochSeconds)) return undefined
  return new Date(epochSeconds * 1000).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
}

function windowLabel(label: string, window?: QuotaWindow): string {
  if (!window) return `${label}：未知`
  const parts: string[] = []
  if (typeof window.usedPercent === "number") {
    const used = Math.max(0, Math.min(100, window.usedPercent))
    parts.push(`已用 ${used.toFixed(used % 1 === 0 ? 0 : 1)}%`, `剩余 ${(100 - used).toFixed(used % 1 === 0 ? 0 : 1)}%`)
  }
  const reset = formatTime(window.resetsAt)
  if (reset) parts.push(`${reset} 重置`)
  return `${label}：${parts.length ? parts.join(" · ") : "未知"}`
}

function shortAccountId(id: string): string {
  return id.length > 13 ? `${id.slice(0, 8)}…` : id
}

function formatBalance(balance?: string | number): string {
  if (balance === undefined || balance === null) return "有"
  const value = typeof balance === "number" ? balance : Number(balance)
  if (!Number.isFinite(value)) return String(balance)
  return value.toFixed(2).replace(/\.00$/, "")
}

function formatCredits(credits?: QuotaCredits, resetCredits?: number): string | undefined {
  const parts: string[] = []
  if (credits?.unlimited) parts.push("Credits：无限")
  else if (credits?.hasCredits) parts.push(`Credits：${formatBalance(credits.balance)}`)
  else if (credits) parts.push("Credits：无")
  if (typeof resetCredits === "number" && resetCredits > 0) parts.push(`重置券：${resetCredits}`)
  return parts.length ? parts.join(" · ") : undefined
}

export function formatReport(report: UsageReport): string {
  const lines: string[] = []
  lines.push("**Codex 用量**")
  lines.push(`更新时间：${new Date(report.generatedAt).toLocaleString("zh-CN", { hour12: false })}`)
  lines.push("")

  if (report.rows.length === 0) {
    lines.push("没有找到可读取的 Codex 账号。")
  }

  for (const row of report.rows) {
    const title = `● ${row.labels.join(" / ")}${row.active ? " [active]" : ""}${row.planType ? ` · ${row.planType}` : ""}`
    lines.push(title)
    lines.push(`  ${windowLabel("5 小时", row.primary)}`)
    lines.push(`  ${windowLabel("周限额", row.secondary)}`)
    const credits = formatCredits(row.credits, row.resetCredits)
    if (credits) lines.push(`  ${credits}`)
    if (row.ordinaryUsageAllowed === false || row.rateLimitReachedType) {
      lines.push("  ⚠ 当前已达到额度限制")
    }
    if (row.cached) {
      const cachedAt = row.cachedAt ? new Date(row.cachedAt).toLocaleString("zh-CN", { hour12: false }) : "未知"
      lines.push(`  缓存数据：${cachedAt}${row.error ? `；实时刷新失败：${row.error}` : ""}`)
    } else if (row.error && !row.primary && !row.secondary) {
      lines.push(`  无法读取：${row.error}`)
    }
    lines.push("")
  }

  if (report.connections.length > 0) {
    lines.push("**OpenCode OpenAI 连接**")
    for (const connection of report.connections) {
      const active = connection.active ? " [active]" : ""
      if (connection.matchedLabel) {
        lines.push(`- ${connection.label}${active} -> 已匹配：${connection.matchedLabel}`)
      } else if (connection.error) {
        if (connection.accountId) {
          const plan = connection.planType ? `（${connection.planType}）` : ""
          const state = connection.expired ? "access token 已过期且刷新失败" : "凭据读取失败"
          lines.push(
            `- ${connection.label}${active} -> 同一 Codex 账号 ${shortAccountId(connection.accountId)}${plan}，${state}（${connection.error}），可重新 /connect`,
          )
        } else {
          lines.push(`- ${connection.label}${active} -> 凭据读取失败（可能需要重新 /connect）：${connection.error}`)
        }
      } else if (connection.kind === "other") {
        lines.push(
          `- ${connection.label}${active} -> 未携带 chatgpt account claim（${connection.methodID || "unknown"}），无法确认账号与额度归属`,
        )
      } else {
        lines.push(
          `- ${connection.label}${active} -> 未匹配到 Codex 账号（该连接使用不同的 OpenAI 认证，无法读取 5h/周额度）`,
        )
      }
    }
    lines.push("")
  }

  for (const note of report.notes) lines.push(`注意：${note}`)
  if (report.notes.length) lines.push("")
  lines.push("只读查询：不会切换账号，也不会修改 OpenAI 配置。")
  return lines.join("\n")
}
