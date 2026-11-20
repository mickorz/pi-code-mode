import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import fs from "node:fs"; import os from "node:os"; import path from "node:path"
const rt = await ModelRuntime.create()
console.log("zhipu 模型:", rt.getModels("cc-switch-zhipu-glm")?.map((m) => `${m.id}(reasoning=${m.reasoning})`).join(", "))
const auth = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "auth.json"), "utf8"))
console.log("已配认证的 provider:", Object.keys(auth).join(", "))
process.exit(0)
