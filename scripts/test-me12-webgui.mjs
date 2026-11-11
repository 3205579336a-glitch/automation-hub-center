// Local fixture only. Requests to the synthetic host are fulfilled by Playwright.
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { chromium } from 'playwright-core'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const cache = new Map()
function load(path) {
  const file = resolve(path)
  if (cache.has(file)) return cache.get(file)
  const module = { exports: {} }
  cache.set(file, module.exports)
  const compiled = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  new Function('require', 'module', 'exports', compiled)(name => name === 'electron'
    ? {} : name.startsWith('.') ? load(join(dirname(file), name + '.ts')) : require(name), module, module.exports)
  return module.exports
}
const { Me12BatchRunner, setMe12PageUrl } = load('src/main/automation/me12-batch-runner.ts')
const url = 'https://ir-fixture.invalid/ME12'
const config = { targetPlant: 'C100', purchasingOrganization: 'C100', infoCategory: 'both', maxRetries: 0, dryRun: false }
const task = { infoRecord: '0012345678', excelRows: [2], targetLeadTime: '0', plannedDeliveryTime: '18', confirmationControl: 'Z004' }

function fixture({ rejectSave = false, wrongCategory = false, missingConsignment = false, readOnlyControl = false,
  missingSlt = false, ambiguousSlt = false, overlap = false, changeUnrequestedPdt = false, saveMode = 'button',
  notice = 'Purchasing info record 0012345678 changed', transientNotice = false, staleNotice = '',
  persistSave = true, wrongReopenedRecord = false, saveDialog = false } = {}) {
  const slt = `<label>Supplier Lead Time: <input id="slt" value="6"${overlap ? ' title="Pl. Deliv. Time"' : ''}></label>`
  const sltHtml = missingSlt ? '' : slt + (ambiguousSlt ? '<label>SLT: <input value="7"></label>' : '')
  const footer = (content) => `<div style="position:fixed;bottom:4px;right:16px;display:flex;gap:12px;align-items:center">${content}<span>Cancel</span></div>`
  const saves = {
    button: '<button data-save><span>Save</span></button>',
    footer: footer('<span data-save style="display:inline-block;padding:5px 9px">Save</span>'),
    nestedFooter: footer('<button data-save><span>Save</span></button>'),
    tooltip: '<button data-save title="Save (Ctrl + S)">✓</button>',
    duplicate: '<button data-save>Save</button>' + footer('<span data-save>Save</span>'),
    stray: '<span data-save>Save</span><button data-save>Save As</button>',
    disabled: '<button data-save disabled>Save</button>',
    modal: '<button data-save>Save</button><div role="dialog"><button data-save>Save</button></div>'
  }[saveMode]
  return `<!doctype html><html><body>
  <main id="form">
    <label>Info Record <input id="ir"></label>
    <label>Plant <input id="plant" value="C100"></label>
    <label>Purchasing Org. <input id="org" value="C100"></label>
    <label>Standard <input type="radio" name="category" value="Standard" checked></label>
    <label>Consignment <input type="radio" name="category" value="Consignment"></label>
  </main>
  <div role="status" id="status">${staleNotice}</div>
  <script>
    document.querySelector('#ir').addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      const record = event.target.value;
      const category = document.querySelector('input[name=category]:checked').value;
      const key = 'record:' + category + ':' + record;
      const saved = JSON.parse(sessionStorage.getItem(key) || 'null');
      if (category === 'Consignment' && ${missingConsignment}) {
        document.querySelector('#status').textContent = 'Purchasing organization data not maintained';
        return;
      }
      const form = document.querySelector('#form');
      form.innerHTML = '<button>Purch. Org. Data 1</button>';
      form.querySelector('button').onclick = () => {
        form.innerHTML = '<label>Info Record <input id="detail-ir" readonly></label>' +
          '<label>Plant <input value="C100" readonly></label>' +
          '<label>Purchasing Org. <input value="C100" readonly></label>' +
          '<span>' + (${wrongCategory} ? 'Consignment' : category) + '</span>' +
          '<label>Pl. Deliv. Time: <input id="pdt" value="10"></label>' +
          ${JSON.stringify(sltHtml)} +
          '<label>Conf. Ctrl: <input id="control" value="Z001" ' + (${readOnlyControl} ? 'readonly' : '') + '></label>' +
          ${JSON.stringify(saves)};
        document.querySelector('#detail-ir').value = saved && ${wrongReopenedRecord} ? '9999999999' : record;
        if (saved) {
          if (document.querySelector('#slt')) document.querySelector('#slt').value = saved[0];
          document.querySelector('#pdt').value = saved[1];
          document.querySelector('#control').value = saved[2];
        }
        for (const save of form.querySelectorAll('[data-save]')) save.addEventListener('click', () => {
          const saves = JSON.parse(sessionStorage.getItem('saves') || '[]');
          const values = [document.querySelector('#slt')?.value ?? null, document.querySelector('#pdt').value, document.querySelector('#control').value];
          saves.push([category, ...values]);
          sessionStorage.setItem('saves', JSON.stringify(saves));
          if (!${rejectSave} && ${persistSave}) sessionStorage.setItem(key, JSON.stringify(values));
          const notice = ${rejectSave} ? 'Error: Save rejected' : ${JSON.stringify(notice)};
          if (${transientNotice}) {
            setTimeout(() => {
              const toast = document.createElement('div');
              toast.className = 'sapToast';
              toast.textContent = notice;
              document.body.append(toast);
              setTimeout(() => toast.remove(), 25);
            }, 80);
          } else if (notice) {
            document.querySelector('#status').textContent = notice;
          }
          if (${saveDialog}) document.body.insertAdjacentHTML('beforeend', '<div role="dialog">Review SAP warning</div>');
        });
        if (${changeUnrequestedPdt}) {
          document.querySelector('#slt').addEventListener('change', () => { document.querySelector('#pdt').value = '99'; });
        }
      };
    });
  </script></body></html>`
}

test('ME12 WebGUI field and save behavior (offline Chrome)', async t => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const run = async (html, runConfig = config, input = task) => {
    const context = await browser.newContext()
    try {
      let navigations = 0
      await context.route('**/*', route => {
        if (route.request().url() !== url) return route.abort()
        navigations++
        return route.fulfill({ contentType: 'text/html', body: html })
      })
      const page = await context.newPage()
      page.screenshot = async () => Buffer.alloc(0)
      await page.goto(url)
      setMe12PageUrl(page, url)
      const runner = new Me12BatchRunner(null, null, '', '', { error: async () => {} }, null)
      const result = await runner.runTaskWithRetries(page, input, runConfig, true, 1)
      const saves = await page.evaluate(() => JSON.parse(globalThis.sessionStorage.getItem('saves') || '[]'))
      return { result, saves, navigations }
    } finally { await context.close() }
  }
  try {
    await t.test('writes all three fields in Standard and Consignment, without reopening the initial page', async () => {
      const { result, saves, navigations } = await run(fixture())
      assert.equal(result.kind, 'success', result.status)
      assert.deepEqual(saves, [['Standard', '0', '18', 'Z004'], ['Consignment', '0', '18', 'Z004']])
      assert.equal(navigations, 2, 'Initial navigation + one category switch only')
      assert.match(result.status, /Standard: Saved.*Consignment: Saved/)
    })
    await t.test('only filled fields change, including zero, each single field and two fields', async () => {
      for (const [changes, expected] of [
        [{ targetLeadTime: '0' }, ['0', '10', 'Z001']],
        [{ plannedDeliveryTime: '0' }, ['6', '0', 'Z001']],
        [{ confirmationControl: 'Z004' }, ['6', '10', 'Z004']],
        [{ targetLeadTime: '4', plannedDeliveryTime: '18' }, ['4', '18', 'Z001']]
      ]) {
        const input = { ...task, targetLeadTime: '', plannedDeliveryTime: '', confirmationControl: '', ...changes }
        const { result, saves } = await run(fixture(), { ...config, infoCategory: 'standard' }, input)
        assert.equal(result.kind, 'success', result.status)
        assert.deepEqual(saves, [['Standard', ...expected]])
      }
    })
    await t.test('SLT never falls back to PDT when its control is absent, duplicate or shares a label', async () => {
      const input = { ...task, plannedDeliveryTime: '', confirmationControl: '' }
      for (const flags of [{ missingSlt: true }, { ambiguousSlt: true }, { overlap: true }]) {
        const { result, saves } = await run(fixture(flags), config, input)
        assert.equal(result.kind, 'failed', result.status)
        assert.match(result.status, /SLT.*No save was sent/)
        assert.deepEqual(saves, [])
      }
      const { result, saves } = await run(fixture({ missingSlt: true }), { ...config, infoCategory: 'standard' },
        { ...task, targetLeadTime: '', confirmationControl: '' })
      assert.equal(result.kind, 'success', result.status)
      assert.deepEqual(saves, [['Standard', null, '18', 'Z001']])
    })
    await t.test('do not save if changing SLT would also change a blank PDT field', async () => {
      const { result, saves } = await run(fixture({ changeUnrequestedPdt: true }), config,
        { ...task, plannedDeliveryTime: '', confirmationControl: '' })
      assert.equal(result.kind, 'failed', result.status)
      assert.match(result.status, /SAP changed unrequested PDT/)
      assert.deepEqual(saves, [])
    })
    await t.test('blank input is preserved; a verified missing category is skipped', async () => {
      const { result, saves } = await run(fixture({ missingConsignment: true }), config, { ...task, targetLeadTime: '', plannedDeliveryTime: '' })
      assert.equal(result.kind, 'success', result.status)
      assert.deepEqual(saves, [['Standard', '6', '10', 'Z004']])
      assert.match(result.status, /Consignment: Skipped/)
    })
    await t.test('readonly requested field or category mismatch prevents any save', async () => {
      for (const options of [{ wrongCategory: true }, { readOnlyControl: true }]) {
        const { result, saves } = await run(fixture(options))
        assert.equal(result.kind, 'failed')
        assert.deepEqual(saves, [])
        assert.match(result.status, /Consignment: Not attempted/)
      }
    })
    await t.test('unverified save is never replayed even when retries are configured', async () => {
      const { result, saves, navigations } = await run(fixture({ rejectSave: true }), { ...config, maxRetries: 2 })
      assert.equal(result.kind, 'failed')
      assert.equal(saves.length, 1)
      assert.equal(navigations, 1)
      assert.match(result.status, /Save outcome unverified/)
    })
    await t.test('captures a transient, numberless WebGUI notice and verifies persisted fields in both categories', async () => {
      const { result, saves, navigations } = await run(fixture({ notice: 'Purchase Infor has been changed', transientNotice: true }))
      assert.equal(result.kind, 'success', result.status)
      assert.match(result.status, /Standard: Saved.*Consignment: Saved/)
      assert.deepEqual(saves, [['Standard', '0', '18', 'Z004'], ['Consignment', '0', '18', 'Z004']])
      assert.equal(navigations, 4, 'One fresh readback per Save')
    })
    await t.test('a numberless notice cannot confirm unsaved values or a different reopened record', async () => {
      for (const [flags, reason] of [
        [{ persistSave: false }, /Reopened SAP SLT does not match/],
        [{ wrongReopenedRecord: true }, /did not confirm the same Info Record/]
      ]) {
        const { result, saves, navigations } = await run(fixture({ notice: 'Purchasing info record has been changed', ...flags }),
          { ...config, maxRetries: 2 })
        assert.equal(result.kind, 'failed', result.status)
        assert.match(result.status, /Save outcome unverified/)
        assert.match(result.status, reason)
        assert.equal(saves.length, 1)
        assert.equal(navigations, 2)
      }
    })
    await t.test('an already visible notice, a different IR notice and a post-save dialog are not accepted', async () => {
      for (const [flags, reason] of [
        [{ staleNotice: 'Purchase Infor has been changed', notice: '' }, /did not return a fresh save confirmation/],
        [{ notice: 'Purchasing info record 0012345679 changed' }, /confirmed a different Info Record/],
        [{ saveDialog: true }, /A SAP dialog opened after Save/]
      ]) {
        const { result, saves, navigations } = await run(fixture(flags), { ...config, maxRetries: 2 })
        assert.equal(result.kind, 'failed', result.status)
        assert.match(result.status, reason)
        assert.equal(saves.length, 1)
        assert.equal(navigations, 1)
      }
    })
    await t.test('recognizes the custom Save next to Cancel and a Save tooltip, with one click each', async () => {
      for (const saveMode of ['footer', 'nestedFooter', 'tooltip']) {
        const { result, saves } = await run(fixture({ saveMode }), { ...config, infoCategory: 'standard' })
        assert.equal(result.kind, 'success', `${saveMode}: ${result.status}`)
        assert.deepEqual(saves, [['Standard', '0', '18', 'Z004']])
      }
    })
    await t.test('ambiguity, stray text, a disabled control and a dialog stop before Save or navigation retry', async () => {
      for (const [saveMode, reason] of [
        ['duplicate', /Multiple visible SAP Save controls/],
        ['stray', /SAP Save button could not be verified/],
        ['disabled', /SAP Save control is disabled/],
        ['modal', /SAP dialog is open/]
      ]) {
        const { result, saves, navigations } = await run(fixture({ saveMode }), { ...config, maxRetries: 2 })
        assert.equal(result.kind, 'failed')
        assert.match(result.status, reason)
        assert.match(result.status, /No save was sent/)
        assert.deepEqual(saves, [])
        assert.equal(navigations, 1, 'Do not reopen a populated form on a Save-control problem')
      }
    })
  } finally { await browser.close() }
})
