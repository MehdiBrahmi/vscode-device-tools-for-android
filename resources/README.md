# Bundled binary: scrcpy server

`scrcpy-server.jar` is the **unmodified** official server from the scrcpy release
[v3.3.4](https://github.com/Genymobile/scrcpy/releases/tag/v3.3.4) (Genymobile, Apache License 2.0; license in `scrcpy-LICENSE.txt`).

SHA-256: `8588238c9a5a00aa542906b6ec7e6d5541d9ffb9b5d0f6e1bc0e365e2303079e`

Verify: `shasum -a 256 scrcpy-server.jar` and compare with the asset digest on the release page.

To upgrade: download `scrcpy-server-vX.Y.Z` from the release, save it as `scrcpy-server.jar`, update `SCRCPY_VERSION` in `src/scrcpy.ts` (the protocol must match exactly), update the version and checksum here and in `THIRD_PARTY_NOTICES.md`.
