import { app, BrowserWindow, dialog, shell, type IpcMainInvokeEvent } from 'electron'
import { access, copyFile, mkdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { extname, join } from 'node:path'

export type TemplateDownloadResult =
  | { success: true; path: string }
  | { success: false; cancelled: boolean; message: string }

interface TemplateDownloadOptions {
  event: IpcMainInvokeEvent
  templatePath: string
  suggestedFileName: string
  configuredDirectory: string
}

export async function downloadTemplateWithSaveDialog(
  options: TemplateDownloadOptions
): Promise<TemplateDownloadResult> {
  await access(options.templatePath, constants.R_OK)
  const downloadDirectory = await resolveDownloadDirectory(options.configuredDirectory)
  const owner = BrowserWindow.fromWebContents(options.event.sender)
  const dialogOptions: Electron.SaveDialogOptions = {
    title: 'Save Excel template',
    defaultPath: join(downloadDirectory, options.suggestedFileName),
    buttonLabel: 'Save template',
    filters: [{ name: 'Excel workbook', extensions: ['xlsx'] }],
    properties: ['createDirectory', 'showOverwriteConfirmation']
  }
  const selection = owner
    ? await dialog.showSaveDialog(owner, dialogOptions)
    : await dialog.showSaveDialog(dialogOptions)

  if (selection.canceled || !selection.filePath) {
    return { success: false, cancelled: true, message: 'Template save was cancelled.' }
  }

  const targetPath = extname(selection.filePath)
    ? selection.filePath
    : `${selection.filePath}.xlsx`
  await copyFile(options.templatePath, targetPath)

  // Give the user an unmistakable completion signal and show the exact file.
  shell.showItemInFolder(targetPath)
  return { success: true, path: targetPath }
}

async function resolveDownloadDirectory(configuredDirectory: string): Promise<string> {
  const configured = configuredDirectory.trim()
  if (configured) {
    try {
      await mkdir(configured, { recursive: true })
      await access(configured, constants.W_OK)
      return configured
    } catch {
      // A saved directory may belong to another user or an unavailable network
      // drive. Fall back to this Windows user's Downloads directory.
    }
  }

  const fallback = app.getPath('downloads')
  await mkdir(fallback, { recursive: true })
  return fallback
}
