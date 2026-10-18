import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, detectShellPath, resolveConfig, toWindowsPath } from '../presets/ptc-minimal/gitbash-executor.mjs'

const win = process.platform === 'win32'

test('toWindowsPath converts MSYS drive paths on win32', { skip: !win }, () => {
  assert.equal(toWindowsPath('/d/foo'), 'D:\\foo')
  assert.equal(toWindowsPath('/d'), 'D:\\')
  assert.equal(toWindowsPath('/D/Foo'), 'D:\\Foo')
  assert.equal(toWindowsPath('/usr/bin'), '/usr/bin')
  assert.equal(toWindowsPath('D:\\foo'), 'D:\\foo')
})

test('detectShellPath explicit config wins', () => {
  const explicit = win ? 'C:\\Custom\\Git\\bin\\bash.exe' : '/opt/bin/bash'
  assert.equal(detectShellPath(explicit, {}), explicit)
})

test('detectShellPath honors GIT_BASH env on win32', { skip: !win }, () => {
  const env = { GIT_BASH: process.execPath }
  assert.equal(detectShellPath(undefined, env), process.execPath)
})

test('detectShellPath on POSIX returns bash regardless of GIT_BASH', { skip: win }, () => {
  assert.equal(detectShellPath(undefined, { GIT_BASH: process.execPath }), 'bash')
})

test('resolveConfig defaults', () => {
  const resolved = resolveConfig({}, {})
  assert.equal(resolved.timeoutMs, 120000)
  assert.equal(resolved.maxTimeoutMs, 600000)
  assert.equal(resolved.maxOutputBytes, 64000)
  assert.equal(resolved.graceMs, 3000)
  assert.equal(typeof resolved.shellPath, 'string')
})

test('start() applies the request timeout to background shells', async () => {
  let capturedSignal
  let providedShell
  const fakeHandle = {
    done: new Promise(() => {}),
    collected: {
      stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
      stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
    },
    terminate: () => {},
  }
  const ctx = {
    get(name) {
      if (name === 'subprocess') return { spawn: (spec) => { capturedSignal = spec.signal; return fakeHandle } }
      if (name === 'sandboxPolicy') return { defaultMode: 'danger-full-access', resolve: () => ({ mode: 'danger-full-access' }) }
      return undefined
    },
    provide(_name, shell) { providedShell = shell },
  }
  apply(ctx, { shellPath: process.execPath, timeoutMs: 30, maxTimeoutMs: 30, graceMs: 10 })
  const proc = providedShell.start(providedShell.resolve({ command: 'sleep 10' }))
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 80))
  assert.equal(capturedSignal.aborted, true)
  proc.kill()
})

test('resolveConfig rejects invalid timer values', () => {
  assert.throws(() => resolveConfig({ timeoutMs: 0 }, {}), /positive/)
  assert.throws(() => resolveConfig({ maxTimeoutMs: 999999999999 }, {}), /no greater than/)
})

test('execute() exposes the rc.2 shell contract the official bash tool calls', async () => {
  let providedShell
  const fakeHandle = {
    done: Promise.resolve({ exitCode: 0, signal: null }),
    collected: {
      stdout: { readFrom: (offset) => ({ text: 'hi\n'.slice(offset), nextOffset: 3, lossy: false }) },
      stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
    },
    terminate: () => {},
  }
  const ctx = {
    get(name) {
      if (name === 'subprocess') return { spawn: () => fakeHandle }
      if (name === 'sandboxPolicy') return { defaultMode: 'danger-full-access', resolve: () => ({ mode: 'danger-full-access' }) }
      return undefined
    },
    provide(_name, shell) { providedShell = shell },
  }
  apply(ctx, { shellPath: process.execPath, timeoutMs: 5000, maxTimeoutMs: 5000, graceMs: 10 })

  assert.equal(typeof providedShell.execute, 'function')
  const spec = providedShell.resolve({ command: 'echo hi' })
  const handle = await providedShell.execute(spec)

  assert.equal(typeof handle.result, 'function')
  assert.deepEqual(Object.keys(handle.observed), ['stdout', 'stderr'])
  assert.equal(handle.observed.stdout.readFrom(0).text, 'hi\n')
  assert.deepEqual(handle.sandbox, { mode: 'danger-full-access', denied: false })

  const result = await handle.result()
  assert.equal(result.exitCode, 0)
  assert.equal(result.timedOut, false)
  assert.equal(result.aborted, false)
  assert.equal(result.stdout.text, 'hi\n')
  assert.equal(result.stderr.text, '')
  assert.deepEqual(result.sandbox, { mode: 'danger-full-access', denied: false })
})
