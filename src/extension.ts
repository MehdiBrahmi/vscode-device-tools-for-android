import * as vscode from 'vscode';
import { registerDeviceManager } from './deviceManager';
import { DeviceManagerView } from './deviceManagerView';
import { RunningDeviceView } from './runningDevices';
import { LogcatView } from './logcat';
import { openExtendedControls } from './extendedControls';

export function activate(ctx: vscode.ExtensionContext) {
  const dm = new DeviceManagerView(ctx.extensionPath);
  const running = new RunningDeviceView(ctx.extensionPath);
  const logcat = new LogcatView(ctx.extensionPath);
  const refresh = () => { dm.refresh(); };

  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider('android.deviceManager', dm, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerWebviewViewProvider('android.runningDevice', running, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerWebviewViewProvider('android.logcat', logcat, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('android.showLogcat', (arg: any) => logcat.show(arg?.kind === 'avd' ? arg.running : arg)),
    vscode.commands.registerCommand('android.extendedControls', (arg: any) => openExtendedControls(ctx.extensionPath, (arg?.kind === 'avd' ? arg.running : arg)?.serial)),
    vscode.commands.registerCommand('android.screenshot', (arg: any) => arg?.serial && running.screenshot(arg.serial)),
    vscode.commands.registerCommand('android.screenRecord', (arg: any) => arg?.serial && running.toggleRecording(arg.serial)),
    vscode.commands.registerCommand('android.refresh', refresh),
    vscode.commands.registerCommand('android.mirrorDevice', (arg: any) => {
      const d = arg?.kind === 'avd' ? arg.running : arg;
      return running.show(d);
    }),
  );
  registerDeviceManager(ctx, refresh);
}

export function deactivate() {}
