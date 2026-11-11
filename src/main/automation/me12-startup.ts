import type { Page } from 'playwright-core'

export class Me12StartupPending extends Error {}

/** Startup only, before any worker is allowed to edit/save a record. */
export async function verifyMe12Startup(
  page: Page, target: URL, navigated: WeakSet<Page>,
  ready: () => Promise<boolean>, signedInShell: () => Promise<boolean>, stopped: () => void
): Promise<void> {
  const assertSapOrigin = (): void => {
    stopped()
    if (page.isClosed()) throw new Error('A SAP browser window was closed. Start again if needed.')
    let origin = ''
    try { origin = new URL(page.url()).origin } catch { /* about:blank / pending certificate */ }
    if (origin !== target.origin) throw new Me12StartupPending('Complete SAP/SSO sign-in in every browser window, then Check Again.')
  }
  const checkReady = async (): Promise<boolean> => {
    const result = await ready()
    assertSapOrigin()
    return result
  }
  assertSapOrigin()
  if (await checkReady()) return
  // SSO can land on SAP home instead of the requested transaction. A verified
  // command field is required: matching hostname alone is NOT authentication.
  if (!navigated.has(page) && await signedInShell()) {
    assertSapOrigin()
    // ME12 can finish rendering while we are checking for the SAP home shell.
    if (await checkReady()) return
    navigated.add(page) // A timeout may follow a successful navigation: no replay.
    try { await page.goto(target.toString(), { waitUntil: 'domcontentloaded', timeout: 10_000 }) }
    catch (error) {
      if (!/timeout/i.test(error instanceof Error ? error.message : String(error))) throw error
    }
    assertSapOrigin()
    if (await checkReady()) return
  }
  assertSapOrigin()
  throw new Me12StartupPending('SAP has not reached ME12. Complete sign-in or handle SAP prompts, enter ME12 if needed, then Check Again. No record was changed.')
}

/** Retry normal startup transitions. Recheck every window in the same pass:
 * a previously ready worker may have lost its session while others sign in. */
export async function waitForMe12Startup(
  checks: readonly (() => Promise<void>)[], stopped: () => void, timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    stopped()
    // Let all probes finish before retrying or unwinding; do not leave a
    // fallback navigation running in the background.
    const results = await Promise.allSettled(checks.map(check => check()))
    stopped()
    const pending: number[] = []
    for (const [index, result] of results.entries()) {
      if (result.status !== 'rejected') continue
      if (!(result.reason instanceof Me12StartupPending)) throw result.reason
      pending.push(index + 1)
    }
    if (!pending.length) return
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new Me12StartupPending(`ME12 is not ready in browser window(s) ${pending.join(', ')}. No record was changed.`)
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(500, remaining)))
  }
}
