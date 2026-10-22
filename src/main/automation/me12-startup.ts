import type { Page } from 'playwright-core'

/** Startup only, before any worker is allowed to edit/save a record. */
export async function verifyMe12Startup(
  page: Page, target: URL, navigated: WeakSet<Page>,
  ready: () => Promise<boolean>, signedInShell: () => Promise<boolean>, stopped: () => void
): Promise<void> {
  stopped()
  if (page.isClosed()) throw new Error('A SAP browser window was closed. Stop and start again.')
  let origin = ''
  try { origin = new URL(page.url()).origin } catch { /* about:blank / pending certificate */ }
  if (origin !== target.origin) throw new Error('Complete SAP/SSO sign-in in every browser window, then Check Again.')
  if (await ready()) return
  // SSO can land on SAP home instead of the requested transaction. A verified
  // command field is required: matching hostname alone is NOT authentication.
  if (!navigated.has(page) && await signedInShell()) {
    stopped()
    navigated.add(page) // A timeout may follow a successful navigation: no replay.
    try { await page.goto(target.toString(), { waitUntil: 'domcontentloaded', timeout: 10_000 }) }
    catch (error) {
      if (!/timeout/i.test(error instanceof Error ? error.message : String(error))) throw error
    }
    stopped()
    if (await ready()) return
  }
  throw new Error('SAP has not reached ME12. Complete sign-in or handle SAP prompts, enter ME12 if needed, then Check Again. No record was changed.')
}
