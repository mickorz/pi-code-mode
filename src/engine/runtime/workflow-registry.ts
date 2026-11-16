/**
 * Workflow Registry（P1 目录扫描；P2 起双模式）
 *
 * manifest 模式（显式注册，唯一管理入口）：<项目>/.pi/workflows/register.json
 *   - 由 /workflows register|unregister 指令写入（extensions/commands/workflows/register.ts）
 *   - 注册不复制脚本：脚本保持原位，manifest 只记录其路径（file，项目相对优先、绝对兑底）
 *   - 条目：{ id, name, description?, file, registeredAt }
 *   - manifest 文件存在即生效（排他）：目录扫描关闭——只能通过指令注册/移除
 *   - loadRegistry 不重新 parse 脚本（id/名称在 manifest 中显式存储）；脚本错误在注册时校验、执行时暴露
 *   - 源文件移动/删除后 run 会报不可读，需重新 register
 *
 * fallback 模式（兼容存量）：manifest 文件不存在时按旧语义扫描 .opencode-workflows/workflows/*.js
 *
 * workflowId = meta.id ?? meta.name（与现有脚本格式零冲突）
 * Schedule 只依赖 workflowId，不依赖文件名/LLM 判断（需求文档第 7 节）。
 */

import fs from "node:fs"
import path from "node:path"
import { parseWorkflowScript } from "./vm.js"

export interface RegisteredWorkflow {
  id: string
  name: string
  description?: string
  /** 脚本绝对/项目相对路径 */
  filePath: string
}

/** manifest 条目（register.json 内的持久化形态；file 为原位脚本路径，项目相对优先、绝对兑底，/ 分隔） */
export interface ManifestEntry {
  id: string
  name: string
  description?: string
  file: string
  registeredAt: string
}

export interface RegistryManifest {
  version: 1
  workflows: ManifestEntry[]
}

export function workflowsDir(directory: string): string {
  return path.join(directory, ".opencode-workflows", "workflows")
}

/** manifest 位置（pi 约定 .pi/workflows/） */
export function registerJsonPath(directory: string): string {
  return path.join(directory, ".pi", "workflows", "register.json")
}

/** 读 manifest；文件不存在返回 null（fallback 目录扫描），JSON 损坏/结构非法上抛根因 */
export function loadManifest(directory: string): RegistryManifest | null {
  const file = registerJsonPath(directory)
  if (!fs.existsSync(file)) return null
  const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as RegistryManifest
  if (raw.version !== 1 || !Array.isArray(raw.workflows)) {
    throw new Error(`注册表 ${file} 结构非法（需要 { version: 1, workflows: [] }）`)
  }
  return raw
}

export function saveManifest(directory: string, manifest: RegistryManifest): void {
  const file = registerJsonPath(directory)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2))
}

/** 追加条目（id 冲突上抛）；调用方负责脚本校验与副本落盘 */
export function addToManifest(directory: string, entry: ManifestEntry): void {
  const manifest = loadManifest(directory) ?? { version: 1 as const, workflows: [] }
  if (manifest.workflows.some((w) => w.id === entry.id)) {
    throw new Error(`workflowId "${entry.id}" 已注册（先 unregister 再重注册）`)
  }
  manifest.workflows.push(entry)
  saveManifest(directory, manifest)
}

/** 按 id 移除条目并返回；manifest 不存在或 id 未找到返回 null */
export function removeFromManifest(directory: string, id: string): ManifestEntry | null {
  const manifest = loadManifest(directory)
  if (!manifest) return null
  const idx = manifest.workflows.findIndex((w) => w.id === id)
  if (idx < 0) return null
  const [removed] = manifest.workflows.splice(idx, 1)
  saveManifest(directory, manifest)
  return removed
}

export function loadRegistry(directory: string): Map<string, RegisteredWorkflow> {
  // manifest 模式：显式注册表为唯一事实源（排他），不做目录扫描
  const manifest = loadManifest(directory)
  if (manifest) {
    const result = new Map<string, RegisteredWorkflow>()
    for (const entry of manifest.workflows) {
      const existing = result.get(entry.id)
      if (existing) {
        throw new Error(`workflowId "${entry.id}" 在注册表中重复：${existing.filePath} 与 ${entry.file}（register.json 被手工改动，id 必须唯一）`)
      }
      result.set(entry.id, {
        id: entry.id,
        name: entry.name,
        description: entry.description,
        filePath: path.resolve(directory, entry.file),
      })
    }
    return result
  }
  // fallback 模式：扫描 .opencode-workflows/workflows/*.js（无 manifest 的存量项目行为不变）
  const dir = workflowsDir(directory)
  const result = new Map<string, RegisteredWorkflow>()
  if (!fs.existsSync(dir)) return result
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue
    const filePath = path.join(dir, entry.name)
    try {
      const script = fs.readFileSync(filePath, "utf-8")
      const { meta } = parseWorkflowScript(script)
      const id = meta.id ?? meta.name
      const existing = result.get(id)
      if (existing) {
        throw new Error(`workflowId "${id}" 重复：${existing.filePath} 与 ${filePath}（meta.id ?? meta.name 必须全局唯一）`)
      }
      result.set(id, { id, name: meta.name, filePath })
    } catch (error) {
      // 单文件解析失败：带文件名上抛根因（脚本非法就修脚本，不做防御跳过）
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`workflows 目录中 ${entry.name} 解析失败：${message}`)
    }
  }
  return result
}

/** 按 workflowId 读脚本原文；不存在抛 WORKFLOW_NOT_FOUND 语义错误 */
export function readWorkflowScript(directory: string, workflowId: string): string {
  const registry = loadRegistry(directory)
  const found = registry.get(workflowId)
  if (!found) {
    const known = Array.from(registry.keys()).join(", ") || "（目录为空或不存在）"
    throw new Error(`WORKFLOW_NOT_FOUND：未找到 workflowId "${workflowId}"（目录 ${workflowsDir(directory)}，已知 id：${known}）`)
  }
  return fs.readFileSync(found.filePath, "utf-8")
}
