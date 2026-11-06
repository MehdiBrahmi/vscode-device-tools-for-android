# Changelog

## Unreleased

- Device Manager: physical devices now show "Manufacturer Model", `Android 17.0 ("Name") | arm64`, the full API level and the Studio start/stop mirroring button.
- Device names now match Android Studio: AVD display name for emulators, "Model API level (serial)" for physical devices (Running Devices and Logcat).

## 0.1.1

- Logcat: search bar (`Cmd/Ctrl+F`) with highlighting, match counter, next/previous, match case, whole word and regex.
- Logcat: fix `level:` filter.

## 0.1.0

- Initial release: Running Devices (emulator gRPC, scrcpy, screenshot fallback), Device Manager, Logcat, Extended Controls.
- Device skin rendering and screenshot options (Rectangular, Display Shape, Show Device Frame).
- Logcat filter language with autocompletion, history, favorites and match case.
