import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { baseBody, createBridgeKit, readSse, sleep } from './testkit.mjs'
const line = 'I1122 run.go:316] Run: attempt 1 failed (RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).), retrying in 4s\n'
async function withKit(fn) {
  const kit = await createBridgeKit({ sessionResume: true, env: { AGY_BRIDGE_CAPACITY_POLL_MS: '20' } })
  try { await fn(kit) } finally { await kit.dispose() }
}
for (const partial of [false, true]) test(`silent bare 429 terminates without quota lock, partial=${partial}`, async () => {
  await withKit(async kit => {
    kit.defaultPrompt = async a => {
      if (partial) await a.text('Already answered. ')
      const file = a.args[a.args.indexOf('--log-file') + 1]
      fs.appendFileSync(file, line.slice(0, 35))
      await sleep(70)
      fs.appendFileSync(file, line.slice(35))
      await a.waitCancel()
      return { stopReason: 'cancelled' }
    }
    const result = await Promise.race([
      kit.request(baseBody({ tools: [], system: '', stream: false })).then(r => r.json()),
      sleep(3000).then(() => { throw new Error('silent retry did not end') }),
    ])
    assert.equal(result.error.type, 'rate_limit_error')
    assert.equal(result.error.noRetry, partial ? true : undefined)
    assert.notEqual(result.error.code, 'QUOTA_EXHAUSTED')
    assert.deepEqual((await kit.plugin.auth.usage()).windows, [])
  })
})
test('old retry lines and non-429 retries do not end the next prompt', async () => {
  await withKit(async kit => {
    let file
    kit.defaultPrompt = async a => {
      file = a.args[a.args.indexOf('--log-file') + 1]
      if (a.index > 0) {
        fs.appendFileSync(file, line.replace('code 429', 'code 503'))
        await sleep(100)
      }
      await a.text('ok')
    }
    const body = baseBody({ tools: [], system: '' })
    const first = await readSse(await kit.request(body))
    fs.appendFileSync(file, line)
    const result = await readSse(await kit.request({ ...body, messages: [...body.messages,
      { role: 'assistant', content: first.content }, { role: 'user', content: 'again' }] }))
    assert.equal(result.error, null)
  })
})
test('late parked checkpoint is read after initial in-memory index load', async () => {
  await withKit(async kit => {
    kit.defaultPrompt = async a => { await a.text(a.sessionId) }
    const body = baseBody({ tools: [], metadata: { user_id: 'late-checkpoint' } })
    const first = await readSse(await kit.request(body))
    const runtime = kit.module.__agyTestRuntimes.get('default')
    const proc = [...runtime.allProcs][0]
    assert.ok(runtime.parked.has(proc.convKey))
    runtime.pool.delete(proc.convKey)
    await proc.stop()
    runtime.parked.clear() // disk checkpoint is newer than this host's empty snapshot
    const reply = await readSse(await kit.request({ ...body, messages: [...body.messages,
      { role: 'assistant', content: first.content }, { role: 'user', content: 'again' }] }))
    assert.equal(reply.content[0].text, first.content[0].text)
  })
})
test('another named account catalog prevents silent family model substitution', async () => {
  await withKit(async kit => {
    await kit.models()
    const root = path.join(kit.home, '.config', 'magpie-agy-cli', 'accounts', 'another')
    fs.mkdirSync(path.join(root, 'bridge-state'), { recursive: true })
    fs.writeFileSync(path.join(root, '.ready'), '1\n')
    const file = path.join(root, 'bridge-state', 'models.json')
    const agy = kit.modelsSpawns[0].file
    fs.writeFileSync(file, JSON.stringify({ version: 1, byAgy: { [agy]: { at: kit.clock.now(),
      list: [{ id: 'gemini-9-pro', name: 'Gemini 9 Pro' }] } } }))
    const before = kit.promptSerial
    const response = await kit.request(baseBody({ model: 'agy-cli/gemini-9-pro', tools: [], stream: false }))
    assert.equal(response.status, 400)
    assert.match((await response.json()).error.message, /another signed-in/)
    assert.equal(kit.promptSerial, before)
    fs.unlinkSync(path.join(root, '.ready'))
    kit.defaultPrompt = async a => { await a.text('ok') }
    assert.equal((await kit.request(baseBody({ model: 'agy-cli/gemini-9-pro', tools: [], stream: false }))).status, 200)
  })
})
test('a newly discovered other-account model must not block an in-flight tool result', async () => {
  await withKit(async kit => {
    let delivered = 0
    kit.defaultPrompt = async a => { await a.tool('Edit', { text: 'once' }); delivered++; await a.text('done') }
    const body = baseBody({ model: 'agy-cli/gemini-9-pro', tools: [{ name: 'Edit', input_schema: { type: 'object', properties: { text: { type: 'string' } } } }] })
    const first = await readSse(await kit.request(body))
    const call = first.content.find(c => c.type === 'tool_use')
    assert.ok(call)
    const root = path.join(kit.home, '.config', 'magpie-agy-cli', 'accounts', 'late-account')
    fs.mkdirSync(path.join(root, 'bridge-state'), { recursive: true })
    fs.writeFileSync(path.join(root, '.ready'), '1\n')
    fs.writeFileSync(path.join(root, 'bridge-state', 'models.json'), JSON.stringify({ version: 1, byAgy: {
      [kit.modelsSpawns[0].file]: { at: kit.clock.now(), list: [{ id: 'gemini-9-pro', name: 'Gemini 9 Pro' }] },
    } }))
    const reply = await readSse(await kit.request({ ...body, messages: [...body.messages,
      { role: 'assistant', content: first.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: 'written' }] }] }))
    assert.equal(reply.error, null)
    assert.equal(delivered, 1)
  })
})
