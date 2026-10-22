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
const { verifyMe12Startup } = module.exports
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
