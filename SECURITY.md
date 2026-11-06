# Security policy

Please report vulnerabilities privately through GitHub's "Report a vulnerability" button (Security tab) rather than a public issue.

Scope notes: the extension runs `adb`, `emulator` and `avdmanager` from the Android SDK, pushes the bundled scrcpy server to devices you choose to mirror, and talks to local emulator gRPC endpoints (127.0.0.1). It has no telemetry and makes no other network calls.
