# Contributing

Thanks for helping! Please read [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) first.

## Prerequisites

- **Node.js 22+** and npm (`.nvmrc` pins 22; required by `@vscode/vsce` 4).
- **VS Code 1.85+**.
- **Android SDK** with `platform-tools`, `emulator`, `cmdline-tools` and at least one system image, to test against real emulators. Set `ANDROID_HOME` or the `android.sdkPath` setting.
- Optional: a physical Android device with USB debugging, to test the scrcpy path.

## Getting started

```bash
git clone <your fork>
cd device-tools-for-android
npm install
npm run compile      # bundle src/ into dist/ with esbuild
```

Press **F5** in VS Code ("Run Extension") to open an Extension Development Host. `npm run watch` rebuilds on save; reload the host window to pick up changes.

| Command | Purpose |
|---|---|
| `npm run compile` / `npm run watch` | Bundle with esbuild |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Unit tests (Node's built-in runner) |
| `npx vsce package` | Build the `.vsix` (also typechecks and minifies) |
| `code --install-extension *.vsix --force` | Install it locally |

## Project layout

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Guidelines

- TypeScript strict mode; webview UIs are plain JS/CSS in `media/` (no framework, no build step).
- Keep platform code portable (macOS, Linux, Windows paths and `.exe`/`.bat` suffixes live in `src/sdk.ts`).
- Add unit tests for pure logic (for example `media/logcat/filter.js`). UI and emulator behaviour is tested manually; say what you tested in the PR.
- Never commit secrets, personal paths, device logs or screenshots containing private data.

## Licensing of contributions and assets

- Contributions are accepted under the project's [MIT license](LICENSE).
- **Do not copy code or assets from Android Studio, IntelliJ or other products unless their license allows redistribution** (Apache-2.0 assets are fine). Do not add Google/JetBrains logos or product artwork.
- Any new third-party file or dependency must be recorded in `NOTICE` and `THIRD_PARTY_NOTICES.md` with its license. Avoid GPL/AGPL/LGPL dependencies.
- The Android emulator `.proto` files and device skins are read from the user's SDK at runtime. They must not be bundled.

## Releasing (maintainers)

1. Update `version` in `package.json` and `CHANGELOG.md`.
2. Tag `vX.Y.Z` and push the tag. The `Release` workflow publishes to the VS Code Marketplace (`VSCE_PAT` secret) and Open VSX (`OVSX_PAT` secret) and attaches the `.vsix` to a GitHub release.
3. First time only: create the `MehdiBrahmi` publisher at https://marketplace.visualstudio.com/manage (it must match the `publisher` field in `package.json`).
