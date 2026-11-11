import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { URL } from 'node:url'
import { test } from 'node:test'
import ts from 'typescript'

const compiled = ts.transpileModule(readFileSync('src/main/automation/me12-startup.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const module = { exports: {} }
new Function('module', 'exports', compiled)(module, module.exports)
const { Me12StartupPending, verifyMe12Startup, waitForMe12Startup } = module.exports
const target = new URL('https://mock.sap/webgui?~transaction=ME12#')

function fixture() {
  const state = { url: target.toString(), closed: false, ready: false, signedIn: false, calls: 0 }
  const page = {
    isClosed: () => state.closed, url: () => state.url,
    goto: async url => { state.calls++; state.url = url }
  }
  const seen = new WeakSet()
  const verify = (stop = () => {}) => verifyMe12Startup(page, target, seen,
    async () => state.ready, async () => state.signedIn, stop)
  return { state, page, verify }
}

test('ME12 startup accepts the ready transaction without navigation', async () => {
  const { state, verify } = fixture()
  state.ready = true
  await verify()
  assert.equal(state.calls, 0)
})

test('same-host login, certificate/about:blank and external SSO never imply authentication', async () => {
  for (const url of [target.toString(), 'about:blank', 'https://sso.example.test/login']) {
    const { state, verify } = fixture()
    state.url = url
    await assert.rejects(verify(), /sign-in/)
    assert.equal(state.calls, 0)
  }
})

test('verified SAP home after SSO enters ME12 once before any worker edits', async () => {
  const { state, page, verify } = fixture()
  state.signedIn = true
  page.goto = async url => { state.calls++; state.url = url; state.ready = true }
  await verify()
  await verify()
  assert.equal(state.calls, 1)
})

test('slow/unauthorized ME12 navigation is not replayed on Check Again', async () => {
  const { state, page, verify } = fixture()
  state.signedIn = true
  page.goto = async () => { state.calls++; throw Error('Navigation timeout') }
  await assert.rejects(verify(), /not reached ME12/)
  await assert.rejects(verify(), /not reached ME12/)
  assert.equal(state.calls, 1)
  state.ready = true
  await verify()
  assert.equal(state.calls, 1)
})

test('ambiguous navigation failure does not repeat the request', async () => {
  const { state, page, verify } = fixture()
  state.signedIn = true
  page.goto = async () => { state.calls++; throw Error('Network interrupted') }
  await assert.rejects(verify(), /Network interrupted/)
  await assert.rejects(verify(), /not reached ME12/)
  assert.equal(state.calls, 1)
})

test('stop or closed window prevents navigation', async () => {
  const { state, verify } = fixture()
  state.signedIn = true
  await assert.rejects(verify(() => { throw Error('Cancelled') }), /Cancelled/)
  state.closed = true
  await assert.rejects(verify(), /closed/)
  assert.equal(state.calls, 0)
})

test('certificate/SSO and delayed ME12 rendering are retried automatically', async () => {
  const { state, verify } = fixture()
  state.url = 'about:blank'
  let checks = 0
  await waitForMe12Startup([async () => {
    checks++
    if (checks === 2) state.url = target.toString()
    if (checks === 3) state.ready = true
    await verify()
  }], () => {}, 3_000)
  assert.equal(checks, 3)
  assert.equal(state.calls, 0, 'Do not reload while the user signs in or ME12 is rendering')
})

test('startup requires all windows to be ready in the same pass', async () => {
  const first = fixture(), second = fixture()
  let pass = 0
  await waitForMe12Startup([
    async () => {
      pass++
      first.state.ready = pass !== 2
      await first.verify()
    },
    async () => {
      second.state.ready = pass > 1
      await second.verify()
    }
  ], () => {}, 3_000)
  assert.equal(pass, 3, 'A window that loses readiness must not be treated as ready')
})

test('expired startup identifies pending windows and allows a fresh manual check', async () => {
  const first = fixture(), second = fixture()
  first.state.ready = true
  const checks = [first.verify, second.verify]
  await assert.rejects(waitForMe12Startup(checks, () => {}, 0),
    { name: 'Error', message: /window\(s\) 2\. No record was changed\./ })
  second.state.ready = true
  await waitForMe12Startup(checks, () => {}, 0)
})

test('closed window is not retried and cancellation wins even if checks pass', async () => {
  const { state, verify } = fixture()
  state.closed = true
  await assert.rejects(waitForMe12Startup([verify], () => {}, 3_000),
    error => !(error instanceof Me12StartupPending) && /closed/.test(error.message))
  let cancelled = false
  await assert.rejects(waitForMe12Startup([async () => { cancelled = true }], () => {
    if (cancelled) throw Error('Cancelled')
  }, 3_000), /Cancelled/)
})

test('startup rejects a ready-looking field after navigation away from SAP', async () => {
  const { state, page } = fixture()
  await assert.rejects(verifyMe12Startup(page, target, new WeakSet(), async () => {
    state.url = 'https://sso.example.test/login'
    return true
  }, async () => false, () => {}), Me12StartupPending)
})
