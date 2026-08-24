# Releasing

## Before the first public release

These are one-time, and none of them can be done from a build machine.

1. **Decide on the licence.** The repository ships MIT (`LICENSE`, and the
   `license` fields in `package.json` and `src-tauri/Cargo.toml`). If you want
   something else, change all three together.

2. **Read the model licences once, properly.** Both models — the draft
   translator and the style-and-terms editor — are covered by the **Gemma Terms
   of Use**. There is no territorial carve-out to worry about any more; what
   there is instead is a prohibited-use policy and a notice requirement, and
   both travel with the weights to whoever ends up holding them. Chitallo never
   redistributes the weights — it downloads them from Hugging Face on an
   explicit user action, with the licence on screen — so the app itself is not a
   redistribution. Both READMEs and the in-app About screen say so; a lawyer's
   eye on that framing is worthwhile before the project is public.

   The weights are pulled from **community re-uploads**, not from the
   publisher's own repositories, which are gated behind a manual approval a
   tokenless download cannot pass. That is a separate provenance question for
   the same lawyer's eye: what the mirror is entitled to distribute, and what
   the app is entitled to point at.

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

2. **Re-verify the model pins.** `model_spec()` in `src-tauri/src/lib.rs` holds,
   for each model, a URL, a byte size and a SHA-256; a download that does not
   match the last two is thrown away. Both URLs point at community mirrors,
   which are free to re-upload under the same path — and if one does, nothing
   warns anybody until every fresh install starts failing its checksum. So
   before a release, fetch the file's current metadata from Hugging Face (a
   `HEAD` on the resolve URL gives the size and the `x-linked-etag`, and the
   repository's file listing gives the SHA-256 for an LFS object) and check both
   numbers against the pins. If they moved, the weights moved: read the entry
   before pinning the new ones.

3. Write the entry in `CHANGELOG.md`.

4. Commit, tag, push:

   ```sh
   git commit -am "Release v0.1.0"
   git tag v0.1.0
   git push && git push --tags
   ```

5. The `Release` workflow builds Windows x64 and both macOS architectures, then
   collects them into a **draft** GitHub release. Open it, check the notes, and
   publish.

## Accepting a build

Do this on a clean machine (or a fresh VM), once per platform, before
publishing the draft:

- Install from the artifact, launch, and walk the first-run setup end to end.
- With llama.cpp **not** installed, confirm the engine step says so and prints
  the right command for that platform — and that «Check again» flips to green
  after you run it, with no app restart. On Windows that command is
  `winget install llama.cpp`, which installs the **Vulkan** build; on a machine
  with an NVIDIA card, accept the build by following README «Which llama.cpp
  build is yours» instead and taking the CUDA archives. `llama-server
  --list-devices` printing `CUDA0` rather than `Vulkan0` is the proof it took.
- Download the weights — up to 21.5 GB across the two models, and the first-run
  wizard asks only for the 7.3 GB draft, so the second one comes from
  Settings → Models — then translate a page from the selection popover. On
  macOS, watch the speed: a page that takes minutes rather than seconds means
  the model landed on the CPU, and the llama.cpp build has no Metal in it.
  That test reads the draft model only. The style-and-terms model is a mixture
  of experts, but on a card that can hold its expert tensors it is now spawned
  with no MoE flag at all — the wording here used to say it was slow by design,
  and that stopped being true when the two servers started taking turns on the
  GPU instead of sharing it. What it needs instead is room to fall back into:
  below about 20 GB of system RAM the spawn is refused outright, with a status
  of its own, rather than left to thrash. A real failure is the server never
  answering: give it up to five minutes to load on a cold page cache, and look
  in `llama-aux.log` in the app data directory if it does not.
- Export a translated book to PDF and open the result. This is the one path
  whose implementation genuinely differs per platform (WebView2 `PrintToPdf` on
  Windows, `NSPrintOperation` on macOS), so a Windows pass says nothing about
  macOS.
- Close the window and confirm no `Chitallo` or `llama-server` process survives
  — **both** of them. There are two servers: 11544 carries the draft model,
  11545 carries the style-and-terms model and is held by a lease that several
  features share, and they take turns on the card — starting 11545 stops 11544,
  and the last lease released starts it again. Do this having run a style pass
  or a terms pass, not just a translation, or 11545 will never have been started
  and the check proves nothing about it. While that pass runs, the draft
  server's status is `swapping` and the panel says «Видеопамять занята правкой
  стиля» rather than showing it dead; a draft server that does not come back
  once the pass has finished is a defect, and the handover is not.

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
