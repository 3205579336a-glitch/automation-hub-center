// Documentation-only UI capture with isolated training data. Never executes SAP.
/* global window, innerWidth, innerHeight */
import { _electron as electron } from 'playwright-core'
import { mkdtemp, mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate'
import assert from 'node:assert/strict'

const root = await mkdtemp(join(tmpdir(), 'hub-manual-'))
const images = resolve('docs/manual-assets')
await mkdir(images, { recursive: true })
const data = join(root, '.local-data', 'data')
await mkdir(data, { recursive: true })
const now = Date.now(), runId = '11111111-1111-4111-8111-111111111111'
const history = [{ id: runId, operation: 'create-rfq', label: 'RFQ training example', summary: 'Illustrative training record',
  startedAt: new Date(now-300000).toISOString(), completedAt: new Date(now-60000).toISOString(), durationMs: 240000,
  status: 'Success', processed: 1, succeeded: 1, skipped: 0, failed: 0, tcode: 'ZMFM050072' }]
await writeFile(join(data, 'execution-history.json'), JSON.stringify(history))
async function rfqFixture(name, invalid = false) {
  const archive = unzipSync(await readFile('resources/templates/Create_RFQ_Template.xlsx'))
  const file = 'xl/worksheets/sheet1.xml', xml = strFromU8(archive[file])
  const prefix = xml.match(/<((?:\w+:)?)sheetData\b/)[1]
  const header = xml.match(new RegExp(`<${prefix}row\\b[^>]*\\br="1"[^>]*>[\\s\\S]*?</${prefix}row>`))[0]
  const rows = [
    ['C100','TRAIN-P001','10000001','12345','supplier@example.com','2030-12-31',invalid?'':'2030-12-31','TRAINTECH',120,'',300,'No'],
    ['C100','TRAIN-P001','10000002','12345','supplier@example.com','2030-12-31','2030-12-31','TRAINTECH',300,10,600,'Yes']
  ]
  const body = rows.map((row,i) => `<${prefix}row r="${i+2}">${row.map((value,j) => `<${prefix}c r="${String.fromCharCode(65+j)}${i+2}" t="inlineStr"><${prefix}is><${prefix}t>${value}</${prefix}t></${prefix}is></${prefix}c>`).join('')}</${prefix}row>`).join('')
  archive[file] = strToU8(xml.replace(new RegExp(`<${prefix}sheetData[^>]*>[\\s\\S]*?</${prefix}sheetData>`),`<${prefix}sheetData>${header}${body}</${prefix}sheetData>`))
  const path = join(root,name); await writeFile(path,zipSync(archive)); return path
}
const good = await rfqFixture('RFQ_training_example.xlsx'), bad = await rfqFixture('RFQ_missing_PPAP_example.xlsx',true)
const result = join(root,'RFQ_training_result.xlsx'); await copyFile(good,result)
let app
try {
  app = await electron.launch({ executablePath: resolve('release/win-unpacked/SAP Automation Toolbox.exe'),
    args: [`--user-data-dir=${root}`], env: { ...process.env, LOCALAPPDATA: root } })
  const page = await app.firstWindow(); page.setDefaultTimeout(45000)
  await page.getByRole('heading',{name:'Welcome back',exact:true}).waitFor()
  const errors=[]; page.on('pageerror',e=>errors.push(e.message))
  await page.evaluate(async folder => {
    const settings = await window.sapAutomation.getSettings()
    await window.sapAutomation.saveSettings({...settings,fontSize:'large',language:'en',theme:'light',notificationSounds:false,defaultDownloadFolder:folder})
  },root)
  await page.reload(); await page.getByRole('heading',{name:'Welcome back',exact:true}).waitFor()
  await app.evaluate(({dialog,ipcMain,BrowserWindow,shell},{good,result,root,runId}) => {
    globalThis.manualFile = good; globalThis.manualPending=null; globalThis.manualInteraction=null
    dialog.showOpenDialog=async()=>({canceled:false,filePaths:[globalThis.manualFile]})
    dialog.showSaveDialog=async(...args)=>({canceled:false,filePath:args.at(-1).defaultPath})
    shell.showItemInFolder=()=>undefined
    const replace=(name,fn)=>{ipcMain.removeHandler(name);ipcMain.handle(name,fn)}
    const owner=BrowserWindow.getAllWindows()[0]
    globalThis.manualEmit=e=>owner.webContents.send('rfq:progress',{runId,stage:'processing',status:'running',...e})
    replace('rfq:start',()=>new Promise(resolve=>{
      globalThis.manualPending=resolve
      globalThis.manualEmit({type:'RUN_STARTED',total:1,current:0,message:'Training example: connecting to SAP.'})
      globalThis.manualEmit({type:'GROUP_STARTED',groupKey:'TRAIN-G001',project:'TRAIN-P001',plant:'C100',supplier:'12345',materials:['10000001','10000002'],current:0,total:1,message:'Training example: finding NPL materials.'})
      globalThis.manualEmit({type:'BUYER_RECEIPT_STARTED',current:0,total:1,message:'Training example: creating Buyer Receipt.'})
    }))
    replace('rfq:cancel',()=>({success:true,message:'Training stop accepted'}))
    replace('automation:interaction:get',()=>globalThis.manualInteraction)
    replace('automation:interaction:respond',()=>({success:true}))
    for(const name of ['me12:start','me01:start','apqp:start','automation:open-sap']) replace(name,()=>{throw new Error('Live execution is forbidden during manual capture')})
    const source = joinPath(root,'Source_List_training.xlsx')
    replace('me01:select-excel-file',()=>({success:true,path:source}))
    replace('me01:preview',()=>({success:true,preview:{sheetName:'ME01_Input',uniqueMaterials:2,uniqueSuppliers:2,totalDataRows:2,duplicateRows:0,
      dualSourcingMaterials:1,singleSourcingMaterials:1,sample:[{material:'10000001',parma:'12345',dualSourcing:false,excelRows:[2]},{material:'10000002',parma:'99999',dualSourcing:true,excelRows:[3]}]}}))
    globalThis.manualFinish=()=>{
      globalThis.manualInteraction=null; owner.webContents.send('automation:interaction',null)
      globalThis.manualEmit({type:'RFQ_CREATED',rfqNumber:'TRAIN-RFQ-001',message:'Training result saved.'})
      globalThis.manualEmit({type:'GROUP_COMPLETED',current:1,total:1,message:'Training group completed.'})
      globalThis.manualEmit({type:'RUN_COMPLETED',current:1,total:1,succeeded:1,skipped:0,failed:0,message:'Training example finished.'})
      globalThis.manualPending({success:true,message:'Illustrative training example; no SAP action was executed.',processed:1,total:1,succeeded:1,skipped:0,failed:0,rfqNumbers:['TRAIN-RFQ-001'],resultPath:result})
    }
    function joinPath(a,b){return a.replace(/[\\/]$/,'')+'/'+b}
  },{good,result,root,runId})
  const capture=async name=>{
    const dismiss=page.getByRole('button',{name:'Dismiss notification',exact:true})
    while(await dismiss.count())await dismiss.first().click()
    const target=page.locator('.page:visible'), box=await target.boundingBox()
    const viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight}))
    if (!box) throw new Error('Visible documentation page is unavailable')
    await page.screenshot({path:join(images,name+'.png'),clip:{x:Math.max(0,box.x),y:Math.max(0,box.y),
      width:Math.min(box.width,viewport.width-Math.max(0,box.x)),height:Math.min(box.height,viewport.height-Math.max(0,box.y))}})
  }
  const card=async(name,heading)=>{
    const target=page.getByRole('heading',{name:heading,exact:true}).locator('..')
    await target.scrollIntoViewIfNeeded();await target.screenshot({path:join(images,name+'.png')})
  }
  const rfqResult=async()=>{
    const number=page.getByText(/TRAIN-RFQ-001/)
    await number.waitFor()
    const dismiss=page.getByRole('button',{name:'Dismiss notification',exact:true})
    while(await dismiss.count())await dismiss.first().click()
    const panel=page.locator('[class*="resultPaths"]')
    await number.scrollIntoViewIfNeeded()
    const top=await panel.boundingBox(), bottom=await number.boundingBox()
    assert(top && bottom)
    await page.screenshot({path:join(images,'10-rfq-result.png'),clip:{x:top.x,y:top.y,width:top.width,height:bottom.y+bottom.height-top.y}})
  }
  const open=async title=>{
    await page.getByRole('button',{name:'Operations',exact:true}).click()
    await page.getByRole('heading',{name:title,exact:true}).locator('..').getByRole('button',{name:'Open',exact:true}).click()
  }
  if (process.argv.includes('--source-only')) {
    await open('Automatically Maintain Source Lists in Batch')
    await page.getByRole('button',{name:'Upload completed template',exact:true}).click()
    await page.getByRole('cell',{name:'No — switch source',exact:true}).waitFor()
    const section=page.getByRole('heading',{name:'Review your batch',exact:true}).locator('xpath=ancestor::section[1]')
    await section.scrollIntoViewIfNeeded()
    await section.getByRole('table').screenshot({path:join(images,'14-source-list.png')})
    console.log('Source List illustration captured; no SAP action executed.')
  } else if (process.argv.includes('--rfq-results-only')) {
    await app.evaluate(({ipcMain,BrowserWindow})=>{
      BrowserWindow.getAllWindows()[0].setContentSize(1720,1400)
      ipcMain.removeHandler('rfq:preview')
      ipcMain.handle('rfq:preview',()=>({success:true,preview:{sheetName:'RPA_Input',totalRows:2,validRows:2,invalidRows:0,
        skippedBlankRows:0,skippedRows:0,duplicateRows:0,plants:['C100'],warnings:[],fingerprint:'training-only',
        sample:[],groupCount:1,groups:[{key:'TRAIN-G001',plant:'C100',project:'TRAIN-P001',supplier:'12345',materials:['10000001','10000002']}]}}))
    })
    await open('Automatically Create Buyer Receipts and RFQs in Batch from NPL')
    await page.getByRole('button',{name:'Upload completed template',exact:true}).click()
    await page.getByRole('heading',{name:'RFQ file ready',exact:true}).waitFor()
    await page.getByRole('button',{name:'Start Automation',exact:true}).click()
    await page.getByRole('button',{name:'Confirm and Start',exact:true}).click()
    await app.evaluate(()=>globalThis.manualFinish())
    await rfqResult()
    console.log('RFQ result illustration captured with simulated events; no SAP action executed.')
  } else {
  await capture('01-dashboard')
  await page.getByRole('button',{name:'Operations',exact:true}).click()
  await page.getByRole('heading',{name:'Automatically Maintain Source Lists in Batch',exact:true}).waitFor()
  await capture('02-operations')
  await page.getByRole('button',{name:'Settings',exact:true}).click(); await page.getByLabel('Language',{exact:true}).waitFor()
  await capture('03-settings')
  await open('Automatically Create Buyer Receipts and RFQs in Batch from NPL')
  await capture('04-rfq-prepare')
  await app.evaluate((electron,path)=>{void electron;globalThis.manualFile=path},bad)
  await page.getByRole('button',{name:'Upload completed template',exact:true}).click()
  await page.getByText('Correct the data and upload again',{exact:true}).waitFor()
  await card('05-rfq-validation','Correct the data and upload again')
  await app.evaluate((electron,path)=>{void electron;globalThis.manualFile=path},good)
  await page.getByRole('button',{name:'Upload completed template',exact:true}).click()
  await page.getByText('RFQ file ready',{exact:true}).waitFor()
  await page.getByText('Parma 12345',{exact:true}).waitFor()
  await card('06-rfq-preview','RFQ file ready')
  await page.getByRole('button',{name:'Start Automation',exact:true}).click()
  await page.getByRole('dialog',{name:'Ready to Start',exact:true}).waitFor()
  await page.getByRole('dialog',{name:'Ready to Start',exact:true}).screenshot({path:join(images,'07-rfq-confirmation.png')})
  await page.getByRole('button',{name:'Confirm and Start',exact:true}).click()
  await page.locator('header').getByText('Running',{exact:true}).waitFor()
  await card('08-rfq-running','Run status')
  await app.evaluate(({BrowserWindow},runId)=>{
    globalThis.manualInteraction={automation:'RFQ',runId,requestId:'manual-commodity',state:'WAITING_FOR_USER',allowedActions:['continue','stop','open-fix-session'],
      recoveryPoint:'COMMODITY_MISSING',materials:['10000001'],groupKey:'TRAIN-G001',rows:[2],message:'Commodity is missing for training material 10000001.',
      issueSummary:'Maintain Commodity for the listed material before Buyer Receipt creation.',instructions:'Use a separate SAP correction session. Keep the paused NPL session unchanged, then select Recheck.'}
    BrowserWindow.getAllWindows()[0].webContents.send('automation:interaction',globalThis.manualInteraction)
  },runId)
  await page.getByRole('dialog',{name:'Commodity Information Required',exact:true}).waitFor()
  await page.getByRole('dialog',{name:'Commodity Information Required',exact:true}).screenshot({path:join(images,'09-action-required.png')})
  await app.evaluate(()=>globalThis.manualFinish())
  await page.getByRole('button',{name:'Open Result File',exact:true}).waitFor()
  await rfqResult()
  await page.getByRole('button',{name:'Execution History',exact:true}).click()
  await page.getByText('1 total, 1 on this page',{exact:true}).waitFor()
  await capture('11-history')
  await open('Automatically Update Supplier Lead Times (SLT) in Batch')
  await capture('12-slt')
  await open('Automatically Query APQP Plan Close Dates in Batch'); await capture('13-apqp')
  await open('Automatically Maintain Source Lists in Batch')
  await page.getByRole('button',{name:'Upload completed template',exact:true}).click()
  await page.getByRole('cell',{name:'No — switch source',exact:true}).waitFor()
  await page.getByRole('heading',{name:'Review your batch',exact:true}).locator('xpath=ancestor::section[1]').getByRole('table').screenshot({path:join(images,'14-source-list.png')})
  await page.getByRole('button',{name:'Settings',exact:true}).click()
  await page.getByLabel('Language',{exact:true}).selectOption('zh-CN')
  await page.getByRole('button',{name:'Save Settings',exact:true}).click()
  await page.getByRole('button',{name:'操作中心',exact:true}).click()
  await page.getByRole('heading',{name:'自动批量 Source List 维护',exact:true}).waitFor()
  await capture('15-operations-zh')
  const recoveryId='22222222-2222-4222-8222-222222222222'
  const recoveryFolder=join(data,'rfq-recovery')
  const outputFolder=join(root,'.local-data','logs','rfq-runs',recoveryId,'output')
  await mkdir(recoveryFolder,{recursive:true}); await mkdir(outputFolder,{recursive:true})
  const recoveryResult=join(outputFolder,'RFQ_training_review.xlsx'); await copyFile(result,recoveryResult)
  const stamp=new Date().toISOString()
  await writeFile(join(recoveryFolder,recoveryId+'.json'),JSON.stringify({version:1,runId:recoveryId,startedAt:stamp,updatedAt:stamp,
    environment:'PROD',engineClosed:true,phase:'review',projects:['TRAIN-P001'],project:'TRAIN-P001',plant:'C100',supplier:'12345',
    materials:['10000001'],totalGroups:12,completedGroupKeys:Array.from({length:7},(_,i)=>'TRAIN-'+(i+1)),uncertainGroupKeys:['TRAIN-8'],
    groupKey:'TRAIN-8',checkpointGroup:'TRAIN-8',lastConfirmedCheckpoint:'BUYER_RECEIPT_SAVED',rfqNumbers:[],resultPath:recoveryResult}))
  await page.evaluate(async()=>{const s=await window.sapAutomation.getSettings();await window.sapAutomation.saveSettings({...s,language:'en'})})
  await page.reload(); await page.getByText('An unfinished RFQ run was found',{exact:true}).waitFor()
  await page.locator('[aria-label="Safe Recovery"]').screenshot({path:join(images,'16-safe-recovery.png')})
  assert.deepEqual(errors,[])
  console.log(JSON.stringify({version:'0.2.4',figures:16,images,trainingOnly:true,sapActions:0}))
  }
} finally { if(app)await app.close();console.log(`Isolated training fixtures retained: ${root}`) }
