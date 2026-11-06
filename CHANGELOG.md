# Changelog

## 0.2.0

### Features

- Device Manager: physical devices show "Manufacturer Model", `Android 17.0 ("Name") | arm64`, the full API level and the Studio start/stop mirroring button.
- Device names match Android Studio: AVD display name for emulators, "Model API level (serial)" for physical devices (Running Devices and Logcat).

### Bug fixes

- Emulator rotation buttons use the emulator rotation sensor like Android Studio (works on the home screen too) and skip the 180° position that phones ignore.
- The emulator screen is re-fitted automatically after a rotation.

### Chores

- Toolchain: TypeScript 7, @types/node 26, @vscode/vsce 4, Node 22 and GitHub Actions v7.

## 0.1.1

- Logcat: search bar (`Cmd/Ctrl+F`) with highlighting, match counter, next/previous, match case, whole word and regex.
- Logcat: fix `level:` filter.

## 0.1.0

- Initial release: Running Devices (emulator gRPC, scrcpy, screenshot fallback), Device Manager, Logcat, Extended Controls.
- Device skin rendering and screenshot options (Rectangular, Display Shape, Show Device Frame).
- Logcat filter language with autocompletion, history, favorites and match case.
