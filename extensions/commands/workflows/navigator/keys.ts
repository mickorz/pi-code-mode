/**
 * Navigator 按键映射：overlay handleInput 收到的是终端原始字节序列，
 * 归一化为逻辑键名供状态机消费（纯函数，可测）。
 */

export function mapKey(data: string): string {
  switch (data) {
    case "\x1b[A":
      return "up"
    case "\x1b[B":
      return "down"
    case "\x1b[C":
      return "right"
    case "\x1b[D":
      return "left"
    case "\r":
    case "\n":
      return "enter"
    case "\x7f":
    case "\b":
    case "\x08":
      return "backspace"
    case "\x1b":
      return "escape"
    case "\t":
      return "tab"
    case "\x1b[Z":
      // Shift+Tab（部分终端发 CSI Z）
      return "shiftTab"
    case "\x1b[5~":
    case "\x1b[5;2~":
      // PageUp（xterm CSI 5~；带修饰位的变体同样归一）
      return "pageUp"
    case "\x1b[6~":
    case "\x1b[6;2~":
      return "pageDown"
  }
  // 单个可打印字符原样透传（含中文；filter 模式逐字符追加）
  if (data.length === 1 && data >= " ") return data
  return "unknown"
}
