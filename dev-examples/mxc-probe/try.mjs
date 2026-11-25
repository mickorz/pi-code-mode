import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, readFile } from 'node:fs/promises'

const ws = await mkdtemp(path.join(os.tmpdir(), 'mxc-try-'))
const cfg = {
  windows: { backend: 'mxc' },
  network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true },
  filesystem: {
    allowWrite: [{ path: ws, literal: true }],
    denyRead: [{ path: path.join(os.homedir(), '.ssh'), literal: true }],
    allowRead: [], denyWrite: [], allowGitConfig: false,
  },
}
try {
  await SandboxManager.initialize(cfg, undefined, false)
  console.log('initialize OK')
  const p = await SandboxManager.spawnSandboxed('cmd /c echo MXC_ALIVE && echo written > in-ws.txt && type in-ws.txt', {
    cwd: ws, commandId: 'mxc-try-1', timeoutMs: 30000,
  })
  let out = ''
  p.stdout?.on('data', c => { out += c.toString() })
  let err = ''
  p.stderr?.on('data', c => { err += c.toString() })
  const r = await p.wait()
  console.log('wait:', JSON.stringify(r))
  console.log('stdout:', JSON.stringify(out.trim()))
  if (err.trim()) console.log('stderr:', JSON.stringify(err.trim().slice(0, 300)))
  console.log('workspace file:', await readFile(path.join(ws, 'in-ws.txt'), 'utf8').catch(() => '<none>'))
  await SandboxManager.cleanupAfterCommand()
  await SandboxManager.reset()
  console.log('reset OK')
} catch (e) {
  console.log('FAILED:', e.constructor?.name, String(e.message).slice(0, 600))
  if (e.code) console.log('code:', e.code)
}
