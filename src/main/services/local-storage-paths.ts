import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export class LocalStoragePaths {
  readonly rootDirectory: string
  readonly dataDirectory: string
  readonly logsDirectory: string
  readonly browserProfilesDirectory: string
  readonly me12ScreenshotsDirectory: string
  readonly settingsPath: string
  readonly executionHistoryPath: string
  readonly legacySettingsPath: string

  constructor(userDataDirectory: string) {
    this.rootDirectory = join(userDataDirectory, '.local-data')
    this.dataDirectory = join(this.rootDirectory, 'data')
    this.logsDirectory = join(this.rootDirectory, 'logs')
    this.browserProfilesDirectory = join(this.rootDirectory, 'browser-profiles')
    this.me12ScreenshotsDirectory = join(this.rootDirectory, 'me12-error-screenshots')
    this.settingsPath = join(this.dataDirectory, 'settings.json')
    this.executionHistoryPath = join(this.dataDirectory, 'execution-history.json')
    this.legacySettingsPath = join(userDataDirectory, 'settings.json')
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.dataDirectory, { recursive: true }),
      mkdir(this.logsDirectory, { recursive: true }),
      mkdir(this.browserProfilesDirectory, { recursive: true }),
      mkdir(this.me12ScreenshotsDirectory, { recursive: true })
    ])

    if (process.platform === 'win32') {
      await execFileAsync('attrib', ['+H', this.rootDirectory]).catch(() => undefined)
    }
  }
}
