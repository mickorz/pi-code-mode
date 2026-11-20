import { ModelRuntime } from "@earendil-works/pi-coding-agent"
const rt = await ModelRuntime.create()
for (const p of rt.getProviders?.() ?? []) {
  const ms = rt.getModels(p?.id ?? p) ?? []
  console.log(`${p?.id ?? p}:`, ms.map((m) => m.id).slice(0, 8).join(", "))
}
process.exit(0)
