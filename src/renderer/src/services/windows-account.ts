let accountRequest: Promise<string | null> | undefined

/** Windows account is shared by local UI consumers only and never stored here. */
export function getWindowsUsername(): Promise<string | null> {
  return accountRequest ??= window.sapAutomation.getLocalUsername().catch(() => {
    accountRequest = undefined
    return null
  })
}
