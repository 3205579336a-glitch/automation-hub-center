/* global window, document */
// UI-only regression. Isolated profile; all automation starts are forbidden.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { _electron as electron } from 'playwright-core'

const root = await mkdtemp(join(tmpdir(), 'hub-laptop-preview-'))
const artifacts = resolve('artifacts/laptop-preview')
await mkdir(artifacts, { recursive: true })
const data = join(root, '.local-data/data')
await mkdir(data, { recursive: true })
await writeFile(join(data, 'execution-history.json'), '[]')
let app
try {
  const started = performance.now()
  app = await electron.launch({ args: ['.', `--user-data-dir=${root}`], env: { ...process.env, LOCALAPPDATA: root } })
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.getByRole('heading', { name: 'Welcome back', exact: true }).waitFor()
  console.log(`Dashboard visible after ${Math.round(performance.now()-started)}ms (local warm development launch).`)
  assert.equal(await page.getByRole('heading', { name: 'RFQ template', exact: true }).count(), 0, 'Unused task pages must not mount during startup')
  const original = await page.evaluate(() => window.sapAutomation.getSettings())
  await app.evaluate(({ipcMain}, root) => {
    const replace = (name, fn) => { ipcMain.removeHandler(name); ipcMain.handle(name,fn) }
    for (const name of ['rfq:start','me12:start','me01:start','apqp:start','automation:open-sap']) {
      replace(name, () => { throw new Error('Live SAP actions are forbidden in laptop UI tests') })
    }
    replace('apqp:select-excel', () => ({success:true,path:root+'/training.xlsx'}))
    globalThis.laptopPreview = {calls:0,defer:false,resolve:null,allExisting:false}
    replace('apqp:preview', () => {
      globalThis.laptopPreview.calls++
      if (globalThis.laptopPreview.rejectHeaders) return {success:false,errorCode:'APQP_TEMPLATE_INVALID',message:'Wrong APQP headers'}
      const sample=[{material:'10000001',vendor:'12345',excelRow:2},{material:'10000002',vendor:'12345',excelRow:3}]
      const keep = {selected:globalThis.laptopPreview.allExisting?0:1,skipped:globalThis.laptopPreview.allExisting?2:1,invalid:0,
        sample:globalThis.laptopPreview.allExisting?[]:sample.slice(0,1)}
      const refresh = {selected:2,skipped:0,invalid:0,sample}
      const result = {success:true,preview:{sheetName:'APQP_Input',...keep,modes:{keepExisting:keep,refreshExisting:refresh}}}
      if (globalThis.laptopPreview.defer) return new Promise(resolve => { globalThis.laptopPreview.resolve=()=>resolve(result) })
      return result
    })
  }, root)
  await page.getByRole('button', {name:'Settings',exact:true}).click()
  assert.equal(await page.getByRole('heading',{name:'Diagnostics / 诊断日志',exact:true}).count(),0,'Diagnostics stays hidden by default')
  await page.getByText('Support & logs',{exact:true}).click()
  await page.getByRole('heading',{name:'Diagnostics / 诊断日志',exact:true}).waitFor()
  await page.getByText('Support & logs',{exact:true}).click()
  await page.getByRole('heading',{name:'Diagnostics / 诊断日志',exact:true}).waitFor({state:'detached'})
  await page.getByLabel('Text Size',{exact:true}).selectOption('large')
  await page.getByRole('button',{name:'Save Settings',exact:true}).click()
  await page.getByText('Settings saved',{exact:true}).waitFor()
  assert.equal(await page.getByText('Advanced / Key User Settings',{exact:true}).count(),0)
  assert.equal(await page.getByText('Estimated savings: manual-time baselines',{exact:true}).count(),0)
  const saved = await page.evaluate(() => window.sapAutomation.getSettings())
  for (const key of ['sapWebGuiUrl','browser','maxConcurrentBrowsers','maxConcurrentSapSessions','manualTimeBaselines']) assert.deepEqual(saved[key],original[key])
  const dismiss=page.getByRole('button',{name:'Dismiss notification',exact:true})
  while(await dismiss.count()) await dismiss.first().click()
  const pages = ['dashboard','operations','create-rfq','me12-lead-time','me01-source-list','apqp-plan-closure','history','settings']
  for (const [width,height] of [[1440,900],[1280,720],[1024,640],[912,560],[800,600],[640,480]]) {
    await app.evaluate(({BrowserWindow}, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width,height])
    for (const route of pages) {
      await page.evaluate(route => { window.location.hash='/'+route }, route)
      await page.locator('.page:visible').waitFor()
      const shape = await page.evaluate(() => {
        const main=document.querySelector('main'), shell=document.querySelector('main')?.parentElement?.parentElement
        return {width:window.innerWidth,height:window.innerHeight,documentWidth:document.documentElement.scrollWidth,
          mainWidth:main.clientWidth,scrollWidth:main.scrollWidth,shellBottom:shell.getBoundingClientRect().bottom}
      })
      assert(shape.documentWidth <= shape.width+1, `${route} ${width}: document overflow ${JSON.stringify(shape)}`)
      assert(shape.scrollWidth <= shape.mainWidth+1, `${route} ${width}: main overflow ${JSON.stringify(shape)}`)
      assert(shape.shellBottom <= shape.height+1, `${route}: page must fit the window height`)
    }
    await page.evaluate(() => { window.location.hash='/operations' })
    await page.screenshot({path:join(artifacts,`operations-${width}x${height}.png`)})
  }
  await page.evaluate(() => { window.location.hash='/apqp-plan-closure' })
  const upload=page.getByRole('button',{name:'Upload completed template',exact:true})
  await upload.click()
  await page.getByRole('cell',{name:'10000001',exact:true}).waitFor()
  const refresh=page.getByLabel('Refresh dates already in Excel',{exact:true})
  const before=await app.evaluate(()=>globalThis.laptopPreview.calls)
  await refresh.selectOption('yes')
  await page.getByRole('cell',{name:'10000002',exact:true}).waitFor()
  await refresh.selectOption('no')
  assert.equal(await page.getByRole('cell',{name:'10000002',exact:true}).count(),0)
  await refresh.selectOption('yes')
  assert.equal(await app.evaluate(()=>globalThis.laptopPreview.calls),before,'Refresh toggles must not reparse Excel')
  assert.equal(await page.getByRole('button',{name:'Start query',exact:true}).isEnabled(),true)
  await page.evaluate(()=>{window.location.hash='/operations'})
  await page.evaluate(()=>{window.location.hash='/apqp-plan-closure'})
  assert.equal(await page.getByRole('cell',{name:'10000002',exact:true}).count(),1,'Navigation preserves selection/preview')
  await app.evaluate(()=>{globalThis.laptopPreview.defer=true})
  await upload.click()
  await page.getByText('Checking your Excel…',{exact:true}).waitFor()
  await page.waitForTimeout(400)
  await app.evaluate(()=>{if(!globalThis.laptopPreview.resolve)throw new Error('Preview request is not pending')})
  const during=await app.evaluate(()=>globalThis.laptopPreview.calls)
  await refresh.selectOption('no'); await refresh.selectOption('yes')
  await app.evaluate(()=>globalThis.laptopPreview.resolve())
  await page.getByRole('cell',{name:'10000002',exact:true}).waitFor()
  assert.equal(await app.evaluate(()=>globalThis.laptopPreview.calls),during,'Toggling during parsing must not launch another parse')
  await app.evaluate(()=>{globalThis.laptopPreview.defer=false;globalThis.laptopPreview.allExisting=true})
  await refresh.selectOption('no')
  await upload.click()
  await page.getByText('No pending records. Check your input and business choices, then upload again.',{exact:true}).waitFor()
  assert.equal(await page.getByRole('button',{name:'Start query',exact:true}).isEnabled(),false)
  const allExisting=await app.evaluate(()=>globalThis.laptopPreview.calls)
  await refresh.selectOption('yes')
  await page.getByRole('cell',{name:'10000002',exact:true}).waitFor()
  assert.equal(await page.getByRole('button',{name:'Start query',exact:true}).isEnabled(),true)
  assert.equal(await app.evaluate(()=>globalThis.laptopPreview.calls),allExisting,'All-dated batches must enable Refresh without reparsing')
  await page.screenshot({path:join(artifacts,'apqp-small-preview.png')})
  await app.evaluate(()=>{globalThis.laptopPreview.rejectHeaders=true})
  await upload.click()
  await page.getByText('Excel headers do not match or the file cannot be read.',{exact:false}).waitFor()
  assert.equal(await page.getByRole('button',{name:'Start query',exact:true}).isEnabled(),false,'Wrong headers cannot enable Start')
  await page.evaluate(async()=>{
    const s=await window.sapAutomation.getSettings()
    await window.sapAutomation.saveSettings({...s,language:'zh-CN',theme:'dark'})
  })
  await page.reload()
  await page.getByRole('heading',{name:'自动批量查询 APQP 计划关闭日期',exact:true}).waitFor()
  for (const route of pages) {
    await page.evaluate(route=>{window.location.hash='/'+route},route)
    await page.locator('.page:visible').waitFor()
    assert(await page.evaluate(()=>{const main=document.querySelector('main');return main.scrollWidth<=main.clientWidth+1}),`Chinese dark layout overflow: ${route}`)
  }
  await page.screenshot({path:join(artifacts,'settings-small-zh-dark.png')})
  const logs=await page.evaluate(()=>window.sapAutomation.getDiagnosticLogs({limit:100}))
  const startup=logs.entries.find(e=>e.event==='application.window-ready')
  assert(startup?.details?.startupMs>=0,'Startup timings must be recorded')
  assert.deepEqual(errors,[])
  console.log(JSON.stringify({startup:startup.details,viewports:6,routes:8,largeFont:true,zhDark:true,apqpPreviewCalls:await app.evaluate(()=>globalThis.laptopPreview.calls),sapActions:0}))
  await readFile(join(data,'settings.json'))
} catch(error) {
  if(app){ const page=await app.firstWindow(); await page.screenshot({path:join(artifacts,'failure.png')}).catch(()=>undefined) }
  throw error
} finally { if(app) await app.close(); console.log(`Isolated test profile: ${root}`) }
