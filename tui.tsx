import { Plugin } from "@opencode/plugin/tui"
import fs from "node:fs"
import { createEffect, createRoot, createSignal, onCleanup } from "solid-js"
import { getCurrentUsage, loadCachedUsage, type QuotaWindow, type UsageSnapshot } from "./quota-api"

type Options = {
  /** 只有这些 provider 下才显示状态栏，默认 ["openai"] */
  providers?: string[]
  /** 忽略 provider 限制，始终显示 */
  alwaysShow?: boolean
  /** 回合结束后的刷新去抖，默认 5000ms */
  debounceMs?: number
}

type Level = "ok" | "warn" | "bad" | "muted"

const HEX: Record<Level, string> = {
  ok: "#3fb950",
  warn: "#d29922",
  bad: "#f85149",
  muted: "#8b949e",
}

const STALE_MS = 15 * 60_000

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 出错只记录，绝不让 TUI 渲染树崩掉。 */
function report(context: any, error: unknown): void {
  const message = errorText(error)
  try {
    console.error(`[codex-usage] ${message}`)
  } catch {
    // ignore
  }
  try {
    const result = context?.client?.app?.log?.({
      body: { service: "codex-usage", level: "warn", message },
    })
    if (result && typeof result.then === "function") result.catch(() => {})
  } catch {
    // ignore
  }
}

function remaining(window?: QuotaWindow): number | undefined {
  if (!window || typeof window.usedPercent !== "number") return undefined
  return Math.max(0, Math.min(100, 100 - window.usedPercent))
}

function used(window?: QuotaWindow): number | undefined {
  if (!window || typeof window.usedPercent !== "number") return undefined
  return Math.max(0, Math.min(100, window.usedPercent))
}

function percent(value?: number): string {
  if (value === undefined) return "—"
  return `${value.toFixed(value % 1 === 0 ? 0 : 1)}%`
}

function resetTime(epochSeconds?: number): string {
  if (typeof epochSeconds !== "number" || !Number.isFinite(epochSeconds)) return "未知"
  return new Date(epochSeconds * 1000).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
}

function level(snapshot?: UsageSnapshot): Level {
  if (!snapshot) return "muted"
  const values = [remaining(snapshot.primary), remaining(snapshot.secondary)].filter(
    (value): value is number => typeof value === "number",
  )
  if (values.length === 0) return "muted"
  const lowest = Math.min(...values)
  if (lowest <= 10) return "bad"
  if (lowest <= 20) return "warn"
  return "ok"
}

function themeColor(context: any, target: Level): string {
  const text = context?.theme?.text ?? {}
  const themed = { ok: text.success, warn: text.warning, bad: text.error, muted: text.muted }[target]
  return typeof themed === "string" ? themed : HEX[target]
}

function footerText(snapshot?: UsageSnapshot, busy?: boolean, error?: string): string {
  if (!snapshot) {
    if (busy) return "5h ⟳ · 7d ⟳"
    return error ? "5h ! · 7d !" : "5h — · 7d —"
  }
  let text = `5h ${percent(remaining(snapshot.primary))} · 7d ${percent(remaining(snapshot.secondary))}`
  if (busy) text += " ⟳"
  else if (error) text += " !"
  else if (Date.now() - snapshot.fetchedAt > STALE_MS) text += " *"
  return text
}

function detailText(snapshot?: UsageSnapshot, error?: string): string {
  if (!snapshot) return error ? `读取失败：${error}` : "尚未读取到额度"
  const lines: string[] = []
  const who = [snapshot.planType, snapshot.email || snapshot.accountId].filter(Boolean).join(" · ")
  if (who) lines.push(who)
  lines.push(
    `5 小时：剩余 ${percent(remaining(snapshot.primary))}（已用 ${percent(used(snapshot.primary))}）· ${resetTime(snapshot.primary?.resetsAt)} 重置`,
  )
  lines.push(
    `周限额：剩余 ${percent(remaining(snapshot.secondary))}（已用 ${percent(used(snapshot.secondary))}）· ${resetTime(snapshot.secondary?.resetsAt)} 重置`,
  )

  const credits: string[] = []
  if (snapshot.credits?.unlimited) credits.push("Credits：无限")
  else if (snapshot.credits?.hasCredits) credits.push(`Credits：${snapshot.credits.balance ?? "有"}`)
  if (typeof snapshot.resetCredits === "number" && snapshot.resetCredits > 0) credits.push(`重置券：${snapshot.resetCredits}`)
  if (credits.length) lines.push(credits.join(" · "))

  if (snapshot.ordinaryUsageAllowed === false || snapshot.rateLimitReachedType) lines.push("⚠ 当前已达到额度限制")

  const at = new Date(snapshot.fetchedAt).toLocaleTimeString("zh-CN", { hour12: false })
  lines.push(`来源：${snapshot.source} · ${at}`)
  if (error) lines.push(`刷新失败：${error}`)
  return lines.join("\n")
}

function setupUsageBar(context: any): (() => void) | undefined {
  if (process.env.CODEX_USAGE_TUI_DEBUG) {
    try {
      fs.appendFileSync(process.env.CODEX_USAGE_TUI_DEBUG, `${new Date().toISOString()} loaded\n`)
    } catch {
      // ignore
    }
  }

  const ui = context?.ui
  const canRender = Boolean(ui?.slot && ui?.model?.current)
  const canListen = Boolean(context?.data?.on)
  const canCommand = Boolean(context?.keymap?.layer)

  if (!canRender) report(context, new Error("ui.slot 或 ui.model.current 不可用，已跳过状态栏"))
  if (!canListen) report(context, new Error("data.on 不可用，回合结束不会自动刷新"))
  if (!canCommand) report(context, new Error("keymap.layer 不可用，ctrl+u / 命令不可用"))

  const options = (context.options ?? {}) as Options
  const providers = options.providers?.length ? options.providers : ["openai"]
  const debounceMs = typeof options.debounceMs === "number" ? Math.max(1000, options.debounceMs) : 5000

  const [snapshot, setSnapshot] = createSignal<UsageSnapshot | undefined>(loadCachedUsage())
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()

  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const refresh = async (force = false) => {
    if (disposed) return
    setBusy(true)
    try {
      const next = await getCurrentUsage({ force })
      if (disposed) return
      setSnapshot(next)
      setError(undefined)
    } catch (err) {
      if (disposed) return
      setError(errorText(err))
    } finally {
      if (!disposed) setBusy(false)
    }
  }

  // 回合结束后刷新：这一轮已经消耗了额度，强制绕过 60s 缓存。
  const schedule = () => {
    if (disposed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      void refresh(true)
    }, debounceMs)
  }

  const visible = () => {
    if (options.alwaysShow) return true
    if (!canRender) return false
    try {
      const model = ui.model.current()
      return Boolean(model && providers.includes(model.providerID))
    } catch (err) {
      report(context, err)
      return false
    }
  }

  if (canRender) {
    try {
      ui.slot({
        append: "prompt.footer.status",
        render: () => {
          try {
            if (!visible()) return null
            return <text fg={themeColor(context, level(snapshot()))}>{footerText(snapshot(), busy(), error())}</text>
          } catch (err) {
            report(context, err)
            return null
          }
        },
      })
    } catch (err) {
      report(context, err)
    }
  }

  const offs: Array<() => void> = []
  if (canListen) {
    for (const event of ["session.execution.succeeded", "session.execution.interrupted"]) {
      try {
        const off = context.data.on(event, schedule)
        if (typeof off === "function") offs.push(off)
      } catch (err) {
        report(context, err)
      }
    }
  }

  const showDetail = async () => {
    await refresh(true)
    const message = detailText(snapshot(), error())
    const dialog = ui?.dialog
    if (dialog?.alert) {
      await dialog.alert({ title: "Codex 用量", message })
      return
    }
    const toast = ui?.toast
    if (toast?.show) {
      toast.show({ title: "Codex 用量", message: message.replace(/\s*\n\s*/g, " · "), duration: 8000 })
      return
    }
    report(context, new Error(message))
  }

  if (canCommand) {
    try {
      context.keymap.layer(() => ({
        mode: "global",
        priority: 10,
        commands: [
          {
            id: "codex-usage.show",
            title: "Codex 额度",
            group: "Codex",
            bind: "ctrl+u",
            palette: true,
            slash: { name: "codex-usage" },
            run: async () => {
              try {
                await showDetail()
              } catch (err) {
                report(context, err)
              }
            },
          },
        ],
      }))
    } catch (err) {
      report(context, err)
    }
  }

  void refresh()

  const dispose = createRoot((disposeRoot) => {
    if (canRender) {
      createEffect(() => {
        try {
          const model = ui.model.current()
          if (model && providers.includes(model.providerID)) void refresh()
        } catch (err) {
          report(context, err)
        }
      })
    }

    onCleanup(() => {
      disposed = true
      for (const off of offs) {
        try {
          off()
        } catch {
          // ignore
        }
      }
      if (timer) clearTimeout(timer)
    })

    return disposeRoot
  })

  return () => dispose()
}

export default Plugin.define({
  id: "codex-usage.tui",
  setup(context) {
    try {
      return setupUsageBar(context)
    } catch (err) {
      report(context, err)
      return
    }
  },
})
