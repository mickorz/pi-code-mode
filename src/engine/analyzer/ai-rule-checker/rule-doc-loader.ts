/**
 * 规则文档加载（AI Rule Checker 的规则基准）
 *
 * 规则文档是 definitions/NN-<ID>-rule.md —— 同一份文档既给人看，也是 AI 的检查依据。
 * 加载失败必须显式暴露（不静默用 description 顶替）：规则文档缺失会让 AI 检查退化成瞎猜。
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { BUILTIN_RULES } from "../rules/index.js"
import type { AIRuleCheckRule } from "./types.js"

/** definitions 与编译产物同目录（dev 走 src、发布走 dist，结构一致） */
export function definitionsDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "rules", "definitions")
}

const FILE_RE = /^(\d{2})-([A-Z]+-\d{3})-rule\.md$/

export interface LoadRulesResult {
  rules: AIRuleCheckRule[]
  /** 缺失或读取失败的问题（不阻断：能加载几条就检查几条） */
  problems: string[]
}

/**
 * 加载全部规则文档。
 * 只返回**有文档**的规则：没有文档就无法指导 AI 判断，不能用 description 冒充规则基准。
 */
export function loadRuleDocs(dir = definitionsDir()): LoadRulesResult {
  const problems: string[] = []
  let files: string[] = []
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"))
  } catch (e) {
    return { rules: [], problems: [`规则文档目录不可读（${dir}）：${String((e as Error)?.message ?? e)}`] }
  }

  const docById = new Map<string, string>()
  for (const file of files) {
    const m = FILE_RE.exec(file)
    if (!m) {
      problems.push(`规则文档命名不符合 NN-<RULE-ID>-rule.md：${file}`)
      continue
    }
    try {
      docById.set(m[2]!, fs.readFileSync(path.join(dir, file), "utf8"))
    } catch (e) {
      problems.push(`规则文档读取失败：${file}（${String((e as Error)?.message ?? e)}）`)
    }
  }

  const rules: AIRuleCheckRule[] = []
  for (const rule of BUILTIN_RULES) {
    const doc = docById.get(rule.id)
    if (!doc) {
      problems.push(`规则 ${rule.id} 缺少规则文档（definitions/NN-${rule.id}-rule.md）`)
      continue
    }
    rules.push({ id: rule.id, severity: rule.severity, description: rule.description, doc })
  }
  return { rules, problems }
}
