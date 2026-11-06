import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Avd, Device, adb, freePort, avdmanagerPath, emulatorPath, installedSystemImages, listAvds, listDevices, run, spawnDetached, writeConfigValues } from './sdk';

type Node = { kind: 'avd'; avd: Avd; running?: Device } | { kind: 'device'; device: Device };

// Embedded mode: no emulator window, the screen is shown in the Running Devices view through the emulator gRPC API.
// avdmanager creates AVDs with hw.gpu.enabled=no, which forces software rendering and makes the emulator very slow.
function enableHostGpu(dir: string) {
  const file = path.join(dir, 'config.ini');
  if (fs.existsSync(file) && /^hw\.gpu\.enabled\s*=\s*no/m.test(fs.readFileSync(file, 'utf8'))) {
    writeConfigValues(file, { 'hw.gpu.enabled': 'yes', 'hw.gpu.mode': 'auto', 'hw.keyboard': 'yes' });
  }
}

async function launchArgs(name: string): Promise<string[]> {
  const avd = listAvds().find((a) => a.name === name);
  if (avd && vscode.workspace.getConfiguration('android').get<boolean>('fixSoftwareRendering', true)) { enableHostGpu(avd.dir); }
  const args = ['-avd', name];
  if (vscode.workspace.getConfiguration('android').get<boolean>('embeddedEmulator', true)) {
    args.push('-qt-hide-window', '-grpc', String(await freePort()));
  }
  return args;
}

const avdOf = (n?: Node) => (n && n.kind === 'avd' ? n.avd : undefined);

async function pickAvd(n?: Node): Promise<Avd | undefined> {
  const a = avdOf(n);
  if (a) { return a; }
  const pick = await vscode.window.showQuickPick(listAvds().map((x) => ({ label: x.name, avd: x })));
  return pick?.avd;
}

export function registerDeviceManager(ctx: vscode.ExtensionContext, onChange: () => void) {
  const reg = (id: string, fn: (...a: any[]) => any) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));
  const guard = (fn: (...a: any[]) => Promise<void>) => async (...a: any[]) => {
    try { await fn(...a); } catch (e: any) { vscode.window.showErrorMessage(e.message ?? String(e)); }
    onChange();
  };

  reg('android.startAvd', guard(async (n) => {
    const a = await pickAvd(n); if (!a) { return; }
    spawnDetached(emulatorPath(), await launchArgs(a.name));
    vscode.window.setStatusBarMessage(`Starting ${a.name}…`, 5000);
  }));
  reg('android.coldBootAvd', guard(async (n) => {
    const a = await pickAvd(n); if (!a) { return; }
    spawnDetached(emulatorPath(), [...(await launchArgs(a.name)), '-no-snapshot-load']);
  }));
  reg('android.stopAvd', guard(async (n) => {
    if (n?.kind === 'avd' && n.running) { await adb(n.running.serial, 'emu', 'kill'); }
  }));
  reg('android.wipeAvd', guard(async (n) => {
    const a = await pickAvd(n); if (!a) { return; }
    if ((await vscode.window.showWarningMessage(`Wipe data of ${a.name}?`, { modal: true }, 'Wipe')) === 'Wipe') {
      spawnDetached(emulatorPath(), [...(await launchArgs(a.name)), '-wipe-data']);
    }
  }));
  reg('android.deleteAvd', guard(async (n) => {
    const a = await pickAvd(n); if (!a) { return; }
    if ((await vscode.window.showWarningMessage(`Delete ${a.name}?`, { modal: true }, 'Delete')) === 'Delete') {
      await run(avdmanagerPath(), ['delete', 'avd', '-n', a.name]);
    }
  }));

  reg('android.createAvd', guard(async () => {
    const images = installedSystemImages();
    if (!images.length) {
      vscode.window.showErrorMessage('No system image installed. Run: sdkmanager "system-images;android-34;google_apis;arm64-v8a"');
      return;
    }
    const img = await vscode.window.showQuickPick(images.map((i) => ({ label: i.label, description: i.id, id: i.id })), { title: 'System image' });
    if (!img) { return; }
    const devOut = await run(avdmanagerPath(), ['list', 'device', '-c']);
    const hw = await vscode.window.showQuickPick(devOut.split('\n').map((s) => s.trim()).filter(Boolean), { title: 'Hardware profile' });
    if (!hw) { return; }
    const name = await vscode.window.showInputBox({
      title: 'AVD name', value: hw.replace(/[^\w.-]/g, '_') + '_API',
      validateInput: (v) => (/^[\w.-]+$/.test(v) ? undefined : 'Letters, digits, . _ - only'),
    });
    if (!name) { return; }
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Creating ${name}…` }, () =>
      run(avdmanagerPath(), ['create', 'avd', '-n', name, '-k', img.id, '-d', hw, '--force'], 'no\n'));
  }));

  reg('android.editAvd', guard(async (n) => {
    const a = await pickAvd(n); if (!a) { return; }
    const file = path.join(a.dir, 'config.ini');
    if (!fs.existsSync(file)) { return; }
    const c = a.config;
    const fields = [
      { label: 'RAM (MB)', key: 'hw.ramSize', cur: c['hw.ramSize'] },
      { label: 'VM heap (MB)', key: 'vm.heapSize', cur: c['vm.heapSize'] },
      { label: 'Internal storage (e.g. 6G)', key: 'disk.dataPartition.size', cur: c['disk.dataPartition.size'] },
      { label: 'CPU cores', key: 'hw.cpu.ncore', cur: c['hw.cpu.ncore'] },
      { label: 'Screen width (px)', key: 'hw.lcd.width', cur: c['hw.lcd.width'] },
      { label: 'Screen height (px)', key: 'hw.lcd.height', cur: c['hw.lcd.height'] },
      { label: 'Screen density (dpi)', key: 'hw.lcd.density', cur: c['hw.lcd.density'] },
      { label: 'Camera back (none/emulated/webcam0)', key: 'hw.camera.back', cur: c['hw.camera.back'] },
      { label: 'Camera front (none/emulated/webcam0)', key: 'hw.camera.front', cur: c['hw.camera.front'] },
      { label: 'Display name', key: 'avd.ini.displayname', cur: c['avd.ini.displayname'] },
    ];
    const changes: Record<string, string> = {};
    for (;;) {
      const pick = await vscode.window.showQuickPick(
        [{ label: '$(check) Save', key: '' }, ...fields.map((f) => ({ label: f.label, description: changes[f.key] ?? f.cur ?? '(unset)', key: f.key }))],
        { title: `Edit ${a.name}` });
      if (!pick) { return; }
      if (!pick.key) { break; }
      const f = fields.find((x) => x.key === pick.key)!;
      const v = await vscode.window.showInputBox({ title: f.label, value: changes[f.key] ?? f.cur });
      if (v !== undefined) { changes[f.key] = v; }
    }
    if (Object.keys(changes).length) {
      writeConfigValues(file, changes);
      vscode.window.showInformationMessage(`${a.name} updated. Restart the emulator to apply${changes['disk.dataPartition.size'] ? ' (storage change needs Wipe Data)' : ''}.`);
    }
  }));

  reg('android.addDevice', guard(async () => {
    const devices = await listDevices();
    const icon = (n: string) => vscode.Uri.file(path.join(ctx.extensionPath, 'media', 'icons', n));
    type Item = vscode.QuickPickItem & { avd?: Avd; pair?: boolean };
    const avds: Item[] = listAvds().map((a) => ({
      label: a.config['avd.ini.displayname'] || a.name.replace(/_/g, ' '),
      description: devices.some((d) => d.avdName === a.name) ? 'running' : undefined,
      iconPath: { light: icon('virtual-light.svg'), dark: icon('virtual-dark.svg') },
      avd: a,
    }));
    const items: Item[] = [
      { label: 'Virtual Devices', kind: vscode.QuickPickItemKind.Separator },
      ...avds,
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: 'Pair Devices Using Wi-Fi', iconPath: { light: icon('pair-over-wifi.svg'), dark: icon('pair-over-wifi.svg') }, pair: true },
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Select a device' });
    if (!pick) { return; }
    if (pick.pair) { await vscode.commands.executeCommand('android.pairDevice'); return; }
    const running = devices.find((d) => d.avdName === pick.avd!.name);
    if (running) { await vscode.commands.executeCommand('android.mirrorDevice', running); }
    else { await vscode.commands.executeCommand('android.startAvd', { kind: 'avd', avd: pick.avd }); }
  }));

  reg('android.pairDevice', guard(async () => {
    const addr = await vscode.window.showInputBox({ title: 'Device address', placeHolder: '192.168.1.20:5555' });
    if (addr) { vscode.window.showInformationMessage((await adb(undefined, 'connect', addr)).trim()); }
  }));
}
