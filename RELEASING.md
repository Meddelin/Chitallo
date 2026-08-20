# Releasing

## Before the first public release

These are one-time, and none of them can be done from a build machine.

1. **Decide on the licence.** The repository ships MIT (`LICENSE`, and the
   `license` fields in `package.json` and `src-tauri/Cargo.toml`). If you want
   something else, change all three together.

2. **Read the model licences once, properly.** The Hunyuan Community License
   that covers HY-MT1.5 is free for commercial use but **does not grant rights
   in the EU, the UK or South Korea**. Chitallo never redistributes the weights —
   it downloads them from Hugging Face on an explicit user action, with the
   licence on screen — so the app itself is not a redistribution. Both READMEs
   and the in-app About screen say so; a lawyer's eye on that framing is
   worthwhile before the project is public.

3. **Code signing (optional, deferred).** Unsigned builds trip SmartScreen on
   Windows and Gatekeeper on macOS. Signing needs, per platform:
   - Windows: an OV/EV code-signing certificate, then `certificateThumbprint`
     or `signCommand` under `bundle.windows` in `src-tauri/tauri.conf.json`.
   - macOS: an Apple Developer account ($99/year), a Developer ID Application
     certificate, and notarisation. `tauri-action` takes `APPLE_CERTIFICATE`,
     `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`,
     `APPLE_PASSWORD` and `APPLE_TEAM_ID` from secrets and does the rest.

   Until then, both READMEs tell users how to get past the warnings.

## Cutting a release

1. Bump the version in **three** places — they must match, or the bundle names
   and the in-app About screen disagree:
   - `package.json` → `version`
   - `src-tauri/Cargo.toml` → `[package] version`
   - `src-tauri/tauri.conf.json` → `version`

2. Write the entry in `CHANGELOG.md`.

3. Commit, tag, push:

   ```sh
   git commit -am "Release v0.1.0"
   git tag v0.1.0
   git push && git push --tags
   ```

4. The `Release` workflow builds Windows x64 and both macOS architectures, then
   collects them into a **draft** GitHub release. Open it, check the notes, and
   publish.

## Accepting a build

Do this on a clean machine (or a fresh VM), once per platform, before
publishing the draft:

- Install from the artifact, launch, and walk the first-run setup end to end.
- With llama.cpp **not** installed, confirm the engine step says so and prints
  the right command for that platform — and that «Check again» flips to green
  after you run it, with no app restart.
- Download the weights, then translate a page from the selection popover. On
  macOS, watch the speed: a page that takes minutes rather than seconds means
  the model landed on the CPU, and the llama.cpp build has no Metal in it.
- Export a translated book to PDF and open the result. This is the one path
  whose implementation genuinely differs per platform (WebView2 `PrintToPdf` on
  Windows, `NSPrintOperation` on macOS), so a Windows pass says nothing about
  macOS.
- Close the window and confirm no `Chitallo` or `llama-server` process survives.

## Auto-updates

Deliberately **off**: the updater needs a signed manifest on hosting that does
not exist yet. When it does, it is three steps:

1. `src-tauri/Cargo.toml`: add `tauri-plugin-updater = "2"`, and in
   `src-tauri/src/lib.rs` add `.plugin(tauri_plugin_updater::Builder::new().build())`.

2. `src-tauri/tauri.conf.json` — a plugin section (keys from
   `npx tauri signer generate`; the private key goes into a CI secret and never
   into the repository):

   ```jsonc
   // add at the root of the config:
   "plugins": {
     "updater": {
       "pubkey": "<public key from tauri signer generate>",
       "endpoints": ["https://<domain>/Chitallo/latest.json"]
     }
   }
   ```

3. A static `latest.json` on that domain, in updater v2 format (`version`,
   `notes`, `pub_date`, `platforms."windows-x86_64"`,
   `platforms."darwin-aarch64"`, `platforms."darwin-x86_64"`, each with
   `signature` and `url`). The bundles are signed with the same key at build
   time, which `tauri-action` does when `TAURI_SIGNING_PRIVATE_KEY` is set.
