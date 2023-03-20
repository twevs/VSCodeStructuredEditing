/**
 * Extension.ts is a lightweight wrapper around ModeHandler. It converts key
 * events to their string names and passes them on to ModeHandler via
 * handleKeyEvent().
 */
import './src/actions/include-main';
import './src/actions/include-plugins';

/**
 * Load configuration validator
 */

import './src/configuration/validators/inputMethodSwitcherValidator';
import './src/configuration/validators/remappingValidator';
import './src/configuration/validators/neovimValidator';
import './src/configuration/validators/vimrcValidator';

import * as vscode from 'vscode';
import { activate as activateFunc, registerCommand, registerEventListener } from './extensionBase';
import { Globals } from './src/globals';
import { Register } from './src/register/register';
import { vimrc } from './src/configuration/vimrc';
import { configuration } from './src/configuration/configuration';
import * as path from 'path';
import { Logger } from './src/util/logger';
import { ClangdContext } from './src/clangd/clangd-context';

export { getAndUpdateModeHandler } from './extensionBase';

export async function activate(context: vscode.ExtensionContext) {
  // Set the storage path to be used by history files
  Globals.extensionStoragePath = context.globalStoragePath;

  await activateFunc(context);

  registerEventListener(context, vscode.workspace.onDidSaveTextDocument, async (document) => {
    if (
      configuration.vimrc.enable &&
      vimrc.vimrcPath &&
      path.relative(document.fileName, vimrc.vimrcPath) === ''
    ) {
      await configuration.load();
      Logger.info('Sourced new .vimrc');
    }
  });

  registerCommand(
    context,
    'vim.editVimrc',
    async () => {
      if (vimrc.vimrcPath) {
        const document = await vscode.workspace.openTextDocument(vimrc.vimrcPath);
        await vscode.window.showTextDocument(document);
      } else {
        await vscode.window.showWarningMessage('No .vimrc found. Please set `vim.vimrc.path.`');
      }
    },
    false
  );

  const outputChannel = vscode.window.createOutputChannel('clangd');
  context.subscriptions.push(outputChannel);

  const clangdContext = new ClangdContext();
  context.subscriptions.push(clangdContext);

  // An empty place holder for the activate command, otherwise we'll get an
  // "command is not registered" error.
  context.subscriptions.push(vscode.commands.registerCommand('clangd.activate', async () => {}));
  context.subscriptions.push(
    vscode.commands.registerCommand('clangd.restart', async () => {
      clangdContext.dispose();
      await clangdContext.activate(context.globalStoragePath, outputChannel);
    })
  );

  await clangdContext.activate(context.globalStoragePath, outputChannel);

  const shouldCheck = vscode.workspace.getConfiguration('clangd').get('detectExtensionConflicts');
  if (shouldCheck) {
    const interval = setInterval(function () {
      const cppTools = vscode.extensions.getExtension('ms-vscode.cpptools');
      if (cppTools && cppTools.isActive) {
        const cppToolsConfiguration = vscode.workspace.getConfiguration('C_Cpp');
        const cppToolsEnabled = cppToolsConfiguration.get<string>('intelliSenseEngine');
        if (cppToolsEnabled?.toLowerCase() !== 'disabled') {
          vscode.window
            .showWarningMessage(
              'You have both the Microsoft C++ (cpptools) extension and ' +
                'clangd extension enabled. The Microsoft IntelliSense features ' +
                "conflict with clangd's code completion, diagnostics etc.",
              'Disable IntelliSense',
              'Never show this warning'
            )
            .then((selection) => {
              if (selection === 'Disable IntelliSense') {
                cppToolsConfiguration.update(
                  'intelliSenseEngine',
                  'disabled',
                  vscode.ConfigurationTarget.Global
                );
              } else if (selection === 'Never show this warning') {
                vscode.workspace
                  .getConfiguration('clangd')
                  .update('detectExtensionConflicts', false, vscode.ConfigurationTarget.Global);
                clearInterval(interval);
              }
            });
        }
      }
    }, 5000);
  }
}

export async function deactivate() {
  await Register.saveToDisk(true);
}
