/**
 * Navigator 状态机（纯逻辑，无宿主依赖——复刻 pi-dynamic-workflows workflow-ui.ts NavigatorModel 的机制）。
 *
 * 四视图：runs（在途+最近）→ detail（run 详情钻取）；saved（注册表）→ savedDetail。
 * 三输入态：browse / filter（"/" 进入逐字输入）/ confirm（破坏性操作二次确认，三重上下文绑定防误触）。
 *
 * act(key) 返回声明式 effects（close/exec-stop/exec-unregister），宿主执行层负责真正落地——
 * 状态机保持可测、不含 I/O。
 */

export type NavigatorInputMode = "browse" | "filter" | "confirm"
export type NavigatorView = "runs" | "saved" | "detail" | "savedDetail"

export interface NavigatorAgentRow {
  id: string
  label?: string
  status: string
  phase?: string
  durationMs?: number
  tokens?: number
  replayed?: boolean
}

export interface NavigatorRunRow {
  runId: string
  label?: string
  status: string
  startedAt?: number
  finishedAt?: number
  error?: string
  agents: NavigatorAgentRow[]
}

export interface NavigatorSavedRow {
  id: string
  name: string
  description?: string
  file: string
}

export type NavigatorEffect =
  | { kind: "close" }
  | { kind: "exec-stop"; runId: string }
  | { kind: "exec-unregister"; id: string }

export interface NavigatorSnapshot {
  mode: NavigatorInputMode
  view: NavigatorView
  filter: string
  confirmPrompt?: string
  /** 过滤后的列表（与渲染/光标一一对应） */
  runs: NavigatorRunRow[]
  saved: NavigatorSavedRow[]
  cursor: { runs: number; saved: number; detail: number }
  scrollTop: { runs: number; saved: number; detail: number }
  detail?: NavigatorRunRow
  savedDetail?: NavigatorSavedRow
}

const EMPTY_CURSORS: NavigatorSnapshot["cursor"] = { runs: 0, saved: 0, detail: 0 }
const EMPTY_SCROLL: NavigatorSnapshot["scrollTop"] = { runs: 0, saved: 0, detail: 0 }

export class NavigatorModel {
  mode: NavigatorInputMode = "browse"
  view: NavigatorView = "runs"
  filter = ""
  private runs: NavigatorRunRow[] = []
  private saved: NavigatorSavedRow[] = []
  private cursors: NavigatorSnapshot["cursor"] = { ...EMPTY_CURSORS }
  private scrollTops: NavigatorSnapshot["scrollTop"] = { ...EMPTY_SCROLL }
  private pending: { action: "stop" | "unregister"; confirmKey: string; runId?: string; id?: string } | undefined

  /** wiring 层每次渲染前注入最新数据（RunManager 快照 + 注册表） */
  setData(runs: NavigatorRunRow[], saved: NavigatorSavedRow[]): void {
    this.runs = runs
    this.saved = saved
  }

  private filteredRuns(): NavigatorRunRow[] {
    const f = this.filter.trim().toLowerCase()
    if (!f) return this.runs
    return this.runs.filter((r) => `${r.runId} ${r.label ?? ""} ${r.status}`.toLowerCase().includes(f))
  }

  private filteredSaved(): NavigatorSavedRow[] {
    const f = this.filter.trim().toLowerCase()
    if (!f) return this.saved
    return this.saved.filter((w) => `${w.id} ${w.name} ${w.description ?? ""}`.toLowerCase().includes(f))
  }

  /** 当前视图的可导航条目数（detail 视图导航的是 agent 行） */
  private itemCount(): number {
    switch (this.view) {
      case "runs":
        return this.filteredRuns().length
      case "saved":
        return this.filteredSaved().length
      case "detail":
        return this.snapshotDetail()?.agents.length ?? 0
      case "savedDetail":
        return 0
    }
  }

  private snapshotDetail(): NavigatorRunRow | undefined {
    if (this.view !== "detail") return undefined
    const runs = this.filteredRuns()
    return runs[this.cursors.runs] ?? this.runs[this.cursors.runs]
  }

  private moveCursor(delta: number): void {
    const key = this.view === "saved" ? "saved" : this.view === "detail" ? "detail" : "runs"
    const max = Math.max(0, this.itemCount() - 1)
    this.cursors[key] = Math.max(0, Math.min(this.cursors[key] + delta, max))
  }

  private setCursor(value: number): void {
    const key = this.view === "saved" ? "saved" : this.view === "detail" ? "detail" : "runs"
    this.cursors[key] = Math.max(0, value)
  }

  /** 滚动窗口：保持 cursor 可见，返回窗口顶部（渲染层据此切片） */
  private ensureWindow(cursor: number, count: number, rows: number, key: keyof NavigatorSnapshot["scrollTop"]): number {
    const cap = Math.max(1, rows)
    let top = this.scrollTops[key]
    if (cursor < top) top = cursor
    if (cursor >= top + cap) top = cursor - cap + 1
    top = Math.max(0, Math.min(top, Math.max(0, count - cap)))
    this.scrollTops[key] = top
    return top
  }

  /** 按键处理；返回宿主执行层要落地的 effects */
  act(key: string): NavigatorEffect[] {
    if (this.mode === "confirm") {
      if (key === "escape") {
        this.mode = "browse"
        this.pending = undefined
        return []
      }
      if (this.pending && key === this.pending.confirmKey) {
        const p = this.pending
        this.pending = undefined
        this.mode = "browse"
        if (p.action === "stop") return [{ kind: "exec-stop", runId: p.runId! }]
        return [{ kind: "exec-unregister", id: p.id! }]
      }
      return [] // confirm 态忽略其它键（三重绑定：同键 + 同目标 + 同光标上下文）
    }
    if (this.mode === "filter") {
      if (key === "escape" || key === "enter") {
        this.mode = "browse"
        return []
      }
      if (key === "backspace") {
        this.filter = this.filter.slice(0, -1)
        return []
      }
      if (key.length === 1 && key >= " ") this.filter += key
      return []
    }
    // browse
    switch (key) {
      case "/":
        if (this.view === "runs" || this.view === "saved") this.mode = "filter"
        return []
      case "q":
        return [{ kind: "close" }]
      case "tab":
        this.view = this.view === "runs" ? "saved" : "runs"
        this.clampRootCursor()
        return []
      case "up":
      case "k":
        this.moveCursor(-1)
        return []
      case "down":
      case "j":
        this.moveCursor(1)
        return []
      case "g":
      case "home":
        this.setCursor(0)
        return []
      case "G":
      case "end":
        this.setCursor(this.itemCount() - 1)
        return []
      case "enter":
      case "right":
        return this.drill()
      case "escape":
      case "left":
        return this.back()
      case "x":
        return this.beginConfirm("stop")
      case "u":
        return this.beginConfirm("unregister")
    }
    return []
  }

  private clampRootCursor(): void {
    const key = this.view === "saved" ? "saved" : "runs"
    const max = Math.max(0, (key === "saved" ? this.filteredSaved() : this.filteredRuns()).length - 1)
    this.cursors[key] = Math.min(this.cursors[key], max)
  }

  private drill(): NavigatorEffect[] {
    if (this.view === "runs" && this.filteredRuns().length) {
      this.cursors.runs = Math.min(this.cursors.runs, this.filteredRuns().length - 1)
      this.view = "detail"
      this.cursors.detail = 0
    } else if (this.view === "saved" && this.filteredSaved().length) {
      this.cursors.saved = Math.min(this.cursors.saved, this.filteredSaved().length - 1)
      this.view = "savedDetail"
    }
    return []
  }

  private back(): NavigatorEffect[] {
    if (this.view === "detail") {
      this.view = "runs"
      return []
    }
    if (this.view === "savedDetail") {
      this.view = "saved"
      return []
    }
    return [{ kind: "close" }]
  }

  private beginConfirm(action: "stop" | "unregister"): NavigatorEffect[] {
    if (action === "stop") {
      if (this.view !== "runs" || !this.filteredRuns().length) return []
      const run = this.filteredRuns()[this.cursors.runs]
      this.pending = { action, confirmKey: "x", runId: run.runId }
      this.mode = "confirm"
      return []
    }
    if (this.view !== "saved" || !this.filteredSaved().length) return []
    const wf = this.filteredSaved()[this.cursors.saved]
    this.pending = { action, confirmKey: "u", id: wf.id }
    this.mode = "confirm"
    return []
  }

  /** 构建渲染快照；bodyRows 为列表区可视行数（滚动窗口计算用） */
  snapshot(bodyRows: number): NavigatorSnapshot {
    const runs = this.filteredRuns()
    const saved = this.filteredSaved()
    this.clampRootCursor()
    const detail = this.view === "detail" ? (runs[this.cursors.runs] ?? this.runs[this.cursors.runs]) : undefined
    const savedDetail = this.view === "savedDetail" ? (saved[this.cursors.saved] ?? this.saved[this.cursors.saved]) : undefined
    const scrollTop = { ...EMPTY_SCROLL }
    if (this.view === "runs" || this.view === "saved") {
      const key = this.view === "runs" ? "runs" : "saved"
      const cursor = this.cursors[key]
      scrollTop[key] = this.ensureWindow(cursor, key === "runs" ? runs.length : saved.length, bodyRows, key)
    } else if (this.view === "detail" && detail) {
      scrollTop.detail = this.ensureWindow(this.cursors.detail, detail.agents.length, Math.max(1, bodyRows - 3), "detail")
    }
    const confirmPrompt = this.pending
      ? `再按 ${this.pending.confirmKey} 执行「${this.pending.action === "stop" ? "停止运行" : "注销工作流"}」（esc 取消）`
      : undefined
    return {
      mode: this.mode,
      view: this.view,
      filter: this.filter,
      confirmPrompt,
      runs,
      saved,
      cursor: { ...this.cursors },
      scrollTop,
      detail,
      savedDetail,
    }
  }
}
