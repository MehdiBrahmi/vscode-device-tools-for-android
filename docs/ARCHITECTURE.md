# Architecture

```
src/
  extension.ts        activation, command registration
  sdk.ts              SDK discovery, adb/emulator/avdmanager helpers, AVD config files,
                      emulator gRPC port and token lookup (avd/running/*.ini)
  deviceManager.ts    AVD commands (create/start/stop/edit/wipe/delete, add device, pairing)
  deviceManagerView.ts  Device Manager webview provider (polls adb every 3 s)
  runningDevices.ts   Running Devices webview: frame pipeline, input, toolbar, skin, screenshot, recording
  emulatorGrpc.ts     Emulator gRPC client (screen stream, touch, keys, native Extended Controls)
  scrcpy.ts           scrcpy server session for physical devices (H.264, decoded in the webview)
  skin.ts             Parses emulator skin "layout" files (device frame)
  extendedControls.ts Native Extended Controls with a webview fallback
  logcat.ts           Logcat panel provider (adb logcat stream, package/pid mapping)
media/
  logcat/             Logcat UI (main.js) and filter language (filter.js, unit-tested)
  devicemanager/      Device Manager UI
  extended/           Extended Controls fallback UI
  icons/ codicons/    Assets (see NOTICE)
resources/            Bundled scrcpy server (see resources/README.md)
```

## Running Devices modes

1. **Emulator gRPC** (preferred): needs `<sdk>/emulator/lib/emulator_controller.proto` and the emulator's gRPC port. Emulators started by Android Studio use `-grpc-use-token`; the token comes from the running `.ini` file. Frames are requested at the displayed pixel size.
2. **scrcpy**: pushes the bundled server over adb, decodes H.264 with WebCodecs in the webview.
3. **Screenshot loop**: `adb exec-out screencap`.

On failure the provider falls back to the next mode.

## Webview/extension messages

Webviews talk to the extension through `postMessage`; message handlers are the `onMessage` switches in each provider. Frames use an ack so that only one frame is in flight.

## Device skins

Read from the AVD's `skin.path` (or `<sdk>/skins/<skin.name>`). Only the portrait layout is rendered; the frame is hidden in landscape.
