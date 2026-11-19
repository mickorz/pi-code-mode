/**
 * 流式输出聚合缓冲（方案 B）。
 *
 * 职责：把 pi 的 `message_update` → `text_delta` 高频分片，聚合成**有界尾部文本**，
 * 按固定间隔节流上抛，避免每个 delta 都触发一次渲染。
 *
 * 约束（关键，违反会破坏语义）：
 *   - 只保留尾部 maxBytes（详情面板只展示尾部几行），防止长输出吃内存
 *   - 只用于**展示**：绝不进 journal、绝不参与 agent hash → resume/回放语义不受影响
 *   - 定时器 unref：不阻塞进程退出
 *
 * 纯逻辑，无 pi SDK 依赖，可单独测试。
 */

export interface PartialBufferOptions {
  /** 保留的尾部字节上限（缺省 8KB） */
  maxBytes?: number
  /** 节流间隔毫秒（缺省 500ms，与渲染的 progress 节流对齐） */
  throttleMs?: number
  /** 节流触发的回调（拿到当前尾部文本） */
  onFlush: (tail: string) => void
}

export interface PartialBuffer {
  /** 收到一个增量分片 */
  push(delta: string): void
  /** 立即冲刷（终态/中止时调用，保证最后一段不丢） */
  flush(): void
  /** 当前累积的尾部文本 */
  tail(): string
  /** 清空缓冲并停掉定时器（attempt 结束/取消） */
  dispose(): void
}

/** 按 UTF-8 安全截断到尾部 maxBytes（不劈开多字节字符） */
function tailByBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ""
  const buf = Buffer.from(text, "utf8")
  if (buf.byteLength <= maxBytes) return text
  let slice = buf.subarray(buf.byteLength - maxBytes).toString("utf8")
  // 起点可能落在多字节字符中间：丢掉首个替换字符
  if (slice.startsWith("�")) slice = slice.slice(1)
  return slice
}

export function createPartialBuffer(options: PartialBufferOptions): PartialBuffer {
  const maxBytes = options.maxBytes ?? 8 * 1024
  const throttleMs = Math.max(1, options.throttleMs ?? 500)
  let text = ""
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const emit = () => {
    if (disposed || !text) return
    try {
      options.onFlush(text)
    } catch (e) {
      // 展示通道故障不得影响 agent 执行
      console.error("[pi-code-mode] 流式输出回调异常:", String((e as Error)?.message ?? e))
    }
  }

  const schedule = () => {
    if (disposed || timer) return
    timer = setTimeout(() => {
      timer = undefined
      emit()
    }, throttleMs)
    ;(timer as { unref?: () => void }).unref?.()
  }

  return {
    push(delta: string): void {
      if (disposed || !delta) return
      text = tailByBytes(text + delta, maxBytes)
      schedule()
    },
    flush(): void {
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      emit()
    },
    tail(): string {
      return text
    },
    dispose(): void {
      disposed = true
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      text = ""
    },
  }
}
