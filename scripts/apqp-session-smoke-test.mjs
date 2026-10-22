/* global window */
// UI-only check of classified APQP/RFQ/ME01 pauses. SAP/browser starts are forbidden.
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const directory = await mkdtemp(join(tmpdir(), 'hub-apqp-session-ui-'))
let app
try {
  const executablePath=process.argv[2] ? resolve(process.argv[2]) : undefined
  app = await electron.launch({...(executablePath ? {executablePath,args:[`--user-data-dir=${directory}`]} : {args:['.',`--user-data-dir=${directory}`]}),env:{...process.env,LOCALAPPDATA:directory}})
  const page = await app.firstWindow()
  await page.getByRole('heading',{name:'Welcome back',exact:true}).waitFor()
  const errors = []
  page.on('pageerror',error=>errors.push(error.message))
  await app.evaluate(({ipcMain})=>{
    const replace=(channel,fn)=>{ipcMain.removeHandler(channel);ipcMain.handle(channel,fn)}
    for(const channel of ['rfq:start','me01:start','me12:start','apqp:start','automation:open-sap']) {
      replace(channel,()=>{throw new Error('SAP/business starts are forbidden in this UI test')})
    }
    globalThis.apqpSessionTest={request:null,checks:0,stops:0}
    replace('automation:interaction:get',()=>globalThis.apqpSessionTest.request)
    replace('automation:interaction:respond',(event,input)=>{
      const state=globalThis.apqpSessionTest
      assertInput(input,state.request)
      if(input.action==='stop'){state.stops++;state.request=null}
      else{
        state.checks++
        state.request={...state.request,requestId:'test-recheck-'+state.checks,
          message:'The issue is still present. [SAP_SESSION_BUSY] COM diagnostic retained',
          issueSummary:'SAP windows are still busy. Wait for SAP to finish, then check again.',
          issueSummaryZh:'SAP 窗口仍在处理中，请等待响应结束后重新检查。'}
      }
      event.sender.send('automation:interaction',state.request)
      return {success:true}
    })
    function assertInput(input,request){
      if(!request||input.requestId!==request.requestId||input.runId!==request.runId)throw new Error('Stale UI request')
    }
  })
  await page.getByRole('button',{name:'Operations',exact:true}).click()
  const card=page.getByRole('heading',{name:'APQP Date Management',exact:true}).locator('..')
  await card.getByRole('button',{name:'Open',exact:true}).click()
  await page.getByRole('tab',{name:'Query Plan Closure Date',exact:true}).click()
  await page.getByText('Before starting, save any work in SAP.',{exact:false}).waitFor()
  for(const language of ['en','zh-CN']){
    if(language==='zh-CN'){
      await page.evaluate(async()=>{const settings=await window.sapAutomation.getSettings();await window.sapAutomation.saveSettings({...settings,language:'zh-CN'})})
      await page.reload()
      await page.getByRole('button',{name:'设置',exact:true}).waitFor()
    }
    for (const automation of ['APQP', 'RFQ', 'ME01']) {
    await app.evaluate(({BrowserWindow}, automation)=>{
      const request={automation,runId:'offline-ui',requestId:'test-initial',state:'WAITING_FOR_USER',
        allowedActions:['continue','stop'],recoveryPoint:'SIGN_IN',step:'SIGN_IN',
        message:'[SAP_MULTIPLE_LOGONS] SAP dialog: License Information for Multiple Logons; SAP pending window visible=True.',
        issueSummary:'SAP is waiting at License Information for Multiple Logons. Review that SAP dialog yourself; the Hub will not end other logons.',
        issueSummaryZh:'949 登录被 SAP“多重登录”提示挡住。请在 SAP 自行处理；Hub 不会结束其他登录。',
        instructions:'SAP login dialogs are displayed, not auto-confirmed.',instructionsZh:'显示 SAP 登录弹窗，但不代点确认。'}
      globalThis.apqpSessionTest.request=request
      BrowserWindow.getAllWindows()[0].webContents.send('automation:interaction',request)
    }, automation)
    const dialog=page.getByRole('dialog')
    await dialog.waitFor()
    await dialog.getByText(language==='en'?'SAP is waiting at License Information for Multiple Logons. Review that SAP dialog yourself; the Hub will not end other logons.':'949 登录被 SAP“多重登录”提示挡住。请在 SAP 自行处理；Hub 不会结束其他登录。',{exact:false}).waitFor()
    await dialog.getByText(language==='en'?'SAP login dialogs are displayed, not auto-confirmed.':'显示 SAP 登录弹窗，但不代点确认。',{exact:true}).waitFor()
    assert.equal(await dialog.getByText(/Check the current SAP RFQ list|请检查 SAP 当前 RFQ 列表/).count(),0)
    await dialog.getByRole('button',{name:language==='en'?'Continue':'继续',exact:true}).click()
    await dialog.getByText(language==='en'?'SAP windows are still busy. Wait for SAP to finish, then check again.':'SAP 窗口仍在处理中，请等待响应结束后重新检查。',{exact:false}).waitFor()
    assert.equal(await dialog.getByText('The issue is still present. SAP could not be verified; correct it and check again.',{exact:true}).count(),0)
    assert.equal(await dialog.getByText('问题仍未解决。系统尚未确认 SAP 状态有效，请处理后再次检查。',{exact:true}).count(),0)
    await dialog.getByRole('button',{name:language==='en'?'Check Again':'再次检查',exact:true}).waitFor()
    await dialog.getByText(language==='en'?'View Details':'查看详情',{exact:true}).click()
    await dialog.getByText('The issue is still present. [SAP_SESSION_BUSY] COM diagnostic retained',{exact:true}).waitFor()
    await dialog.getByRole('button',{name:language==='en'?'Stop Automation':'停止自动化',exact:true}).click()
    await dialog.waitFor({state:'hidden'})
    }
  }
  assert.deepEqual(await app.evaluate(()=>({checks:globalThis.apqpSessionTest.checks,stops:globalThis.apqpSessionTest.stops})),{checks:6,stops:6})
  assert.deepEqual(errors,[])
  console.log('APQP/RFQ/ME01 session UI passed: English/Chinese reasons and startup instructions, changed reason after recheck, retained details, safe Stop. No SAP actions.')
} finally {
  if(app)await app.close()
  console.log('Isolated UI profile:',directory)
}
