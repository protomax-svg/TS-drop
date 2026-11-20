# TSDROP

Move sensitive data between your own devices, over your own [Tailscale](https://tailscale.com)
network, and nowhere else. Chat, tags, files of any size.

**Nextcloud over WebDAV is the main path** — upload once, it is there whether the sending
device is on or not, and private chats add real end-to-end encryption on top.
**Direct mode skips the cloud entirely** — device to device, nothing stored anywhere, one
network hop instead of two, so it is the fast option for a big file when both devices are
online.

Nothing of ours is in the middle. No account to make, no service to sign up for, no port
opened to the internet. If your tailnet is up, TSDROP works; if it is down, TSDROP does
nothing.

```
  Windows        Linux         Android
     |             |              |
     +------ your tailnet (WireGuard) ------+
     |                                      |
  Nextcloud over WebDAV            device to device, direct
  (main path, files at rest)       (fast path, bytes never stored)
```

Runs on Windows 10/11, Linux (Electron — including Omarchy, where it wears the desktop's
own theme) and Android (Capacitor).

---

## What you need first

1. **Tailscale on every device**, all logged in to the same tailnet.
   TSDROP does not bundle it and does not install it. On Android the Tailscale app must be
   connected, or nothing is reachable.
2. **A Nextcloud** on one of those devices (or anywhere else on the tailnet), reachable on the
   tailnet address. TSDROP only speaks plain WebDAV, so any Nextcloud will do.
3. **A Nextcloud app password** for the account TSDROP uses. The app asks for it on first run.
   It is never in the source and never committed.

Copy `.env.example` to `.env` and put your tailnet addresses in it before you build.
See [Tailscale](#tailscale) below.

---

## Install

**Linux (Kubuntu, Debian)** — pick one:

```bash
sudo dpkg -i release/TSDROP-<version>-amd64.deb        # installs as `tsdrop`
# or
chmod +x release/TSDROP-<version>-x86_64.AppImage && ./release/TSDROP-<version>-x86_64.AppImage
```

**Linux (Arch, Omarchy)**:

```bash
sudo pacman -U release/TSDROP-<version>-x64.pacman     # installs as `tsdrop`
./omarchy/install.sh                                   # window rules + Super+Insert
```

The AppImage wants `fuse2`, which Arch does not install by default, so the package is the
easier path. [Omarchy](#omarchy) below is the rest of it.

**Windows 10 / 11** — run `release/TSDROP-Setup-<version>.exe`.
No admin rights needed, it installs per user. `release/TSDROP-portable-<version>.exe` needs no install at all.

**Android** — copy `release/TSDROP-<version>.apk` to the phone and open it.
Allow "install unknown apps" once.

---

## The window

TSDROP is a small vertical popup, not a full window. It has no title bar.
Drag it by the top strip. `×` hides it, it does not quit. Quit from the tray menu.

It opens **on the tray icon**, not in the middle of the screen:

* **Windows 10 / 11** — right above the tray icon in the taskbar. Correct on any taskbar edge.
* **Linux / X11** — same.
* **Linux / Wayland** — the compositor decides where windows go, so the app cannot place itself,
  and does not try. KDE will put it where it likes. On Hyprland a window rule does the placing
  instead — see [Omarchy](#omarchy).

Its size is remembered.

## Ctrl+Insert

Click the tray icon, or press **Ctrl+Insert**, to show and hide it.

Works out of the box on Windows and Linux/X11.

**Wayland hands hotkeys to the compositor, not to apps.** On Hyprland the binding lives in
Hyprland's config — `./omarchy/install.sh` puts it there as **Super+Insert**, see
[Omarchy](#omarchy). On KDE the `.deb` ships the shortcut in its desktop entry, so it should
just work. If it does not:

> System Settings -> Keyboard -> Shortcuts -> Add Command -> `tsdrop` -> assign `Ctrl+Ins`

Launching `tsdrop` while it is already running toggles the window. That is what the shortcut uses.

---

## Omarchy

[Omarchy](https://omarchy.org) is Arch with Hyprland, and both halves of that change what the
app is allowed to do for itself. Two things to install, one of which is a one-liner.

**The package.** `npm run dist:arch` builds `release/TSDROP-<version>-x64.pacman`; `sudo pacman -U`
it. The build uses the Electron that Arch already installed (`electron43`) when the major
matches, so it does not pull 110 MB of the same runtime down again.

**The window.** Wayland does not let a window place itself, so without a rule the popup opens
as a tile, full height, wherever the layout puts it. The rule lives in Hyprland's config:

```bash
./omarchy/install.sh            # --remove takes it out again
```

That writes `~/.config/hypr/tsdrop.lua` and adds one `require` line to
`~/.config/hypr/hyprland.lua`, backing up whatever it touches. TSDROP then floats in the bottom
right corner, at the size it remembers, and fades with every other Omarchy window because the
rule leaves opacity alone.

**The key is Super+Insert**, not Ctrl+Insert: Omarchy sends Ctrl+Insert to terminals as copy
(it is what Super+C does there), and terminals have meant it as copy for far longer than that.
Change the chord in `~/.config/hypr/tsdrop.lua` if it is in your way. Either way it works the
same as everywhere else — launching `tsdrop` while it runs shows or hides the window.

`×` still hides to the tray; Omarchy's bar has one, behind the `<` on the right.

For TSDROP to be there from login rather than on first launch, put
`o.launch_on_start("tsdrop")` in `~/.config/hypr/autostart.lua`.

**The theme.** TSDROP wears whatever the desktop is wearing. `omarchy theme set <name>`
repaints the app as it repaints the terminal and the bar, with no restart and nothing to
configure:

* colours come from `~/.local/state/omarchy/current/theme/colors.toml`, the same file the
  rest of the desktop is themed from
* the monospace font is whatever `fc-match monospace` answers, which is what `omarchy font set`
  changes
* both are watched, so a theme change lands in the window as it happens

`⚙` → `theme` switches between `auto ◆ <theme>` and the app's own `dark ◑` / `light ◐`, for
when you want TSDROP to stay put while the desktop changes.

---

## How it works

Every device talks straight to Nextcloud. There is no middle server.

```
file-transfer-app/
  chats/<chatId>/chat.json        name, accent colour
  chats/<chatId>/m/<msgId>.json   one message: text, tags, file list
  inbox/<chatId>/<msgId>/<file>   the attachments
```

* New messages are found by listing `chats/<id>/m/` every 3 seconds.
* Files are streamed. Nothing is loaded into memory, so size does not matter.
* Messages are cached on the device, so search is instant and works offline.

### No re-encoding, ever

Images and video go over as the exact bytes you picked. Nothing is resized, recompressed or stripped.

* the file picker uses the document picker, which hands over the original file
* uploads stream the raw bytes
* previews are drawn from those same bytes, scaled for display only
* a copied **file** on the clipboard is attached as-is, EXIF and all
* a copied **screenshot** has no original file, so it is saved as PNG, which is lossless

One thing outside my control: if you pick a photo through **Google Photos** rather than **Files**,
Photos itself may hand over a processed copy. Pick through Files if the exact bytes matter.

---

## Tailscale

Tailscale is what makes the whole thing work. It gives every device of yours a private
WireGuard network — a *tailnet*. Each device gets a stable address in `100.64.0.0/10`
(for example `100.101.102.103`) and a MagicDNS name (`laptop.tailXXXX.ts.net`). Those addresses
only exist inside your tailnet. Nobody outside it can route to them, whatever port is open.

TSDROP leans on that in three places.

### 1. Reaching Nextcloud

The WebDAV endpoint is a tailnet address, not a public one:

```
http://<machine>.<tailnet>.ts.net:8080/remote.php/dav/files/<user>/file-transfer-app
```

Every device talks straight to that. There is no relay, no rendezvous server, no middle
service of ours. Plain `http` is fine here **because WireGuard already encrypts the hop** —
TLS on top would encrypt an already encrypted tunnel. Your Nextcloud never needs a public
certificate, a public DNS name, or a hole in your router.

On start the app tries each candidate endpoint with a `PROPFIND` and keeps the first that
answers `207`. Order:

1. whatever you typed in **Setup (⚙)**
2. the last endpoint that worked, saved on the device
3. the list from `VITE_DAV_ENDPOINTS` in `.env`, baked in at build time

Put the MagicDNS name first and the raw `100.x.y.z` address second. The name is nicer; the
IP always works.

**MagicDNS names need Nextcloud's permission.** Nextcloud answers `400 Bad Request` to any
`Host:` header it does not know, so a MagicDNS name fails until you add it. On the Nextcloud
host, in `config/config.php`:

```php
'trusted_domains' => [
  '100.x.y.z:8080',
  '<machine>.<tailnet>.ts.net:8080',
],
```

Until you do that, the app silently falls back to the IP, which is why it still works.

### 2. Direct mode — device to device, nothing stored

With `DIRECT ⇄`, the file is never uploaded. The sending device serves the bytes itself and
the message carries only the name, the size and a one-time token.

The sender starts a tiny HTTP server and **binds it to its tailnet IP only** — never to
`0.0.0.0`, so it is not on your LAN and not on your Wi-Fi, only on the tailnet. It finds that
IP by walking the network interfaces and taking the first non-internal IPv4 in
`100.64` – `100.127`, whatever the Tailscale interface happens to be called on that OS.
Port `8421`, or a random free one if `8421` is taken.

```
GET http://100.x.y.z:8421/b/<token>     ->  the file, streamed
GET http://100.x.y.z:8421/ping          ->  "tsdrop", used to see if the peer is up
```

The token is 12 random bytes, base64url, one per file. That token *is* the access control:
there is no listing, no directory, no guessing — an unknown token gets `404`. Reachability is
Tailscale's job, and it already limits the server to your own devices.

Direct files are not AES wrapped even inside a private chat. They never rest on a server, and
WireGuard encrypts the hop, so a second layer would buy nothing.

What it costs: **the sending device must be awake with TSDROP running.** If it is not, the
other end shows `<device> is offline — open TSDROP there`. Nothing is lost, you just open the
app on that device. A desktop lives in the tray so it serves nearly always; a phone serves
only while the app is open.

If Tailscale is down on the sending device there is no `100.x` address to bind to, so direct
mode refuses with `direct needs tailscale up on this device — switch to CLOUD`.

Both ends must be allowed to reach that port. Tailscale's default ACL (`autogroup:member` may
reach anything) already allows it. If you tightened your ACLs, permit TCP `8421` between your
own devices.

### 3. The peer list in Setup

**Setup (⚙)** runs `tailscale status --json` and shows your tailnet name, this device, and
every peer with its IP, OS and online state. Click a peer to point the app at it.

This is **desktop only** — Android has no `tailscale` CLI to call. If the CLI is missing,
Setup says so and you type the endpoint by hand. Nothing else in the app depends on it; the
app never needs the CLI to move a single byte.

### Where the tailnet shows up in the code

| File | What it does with Tailscale |
|---|---|
| `src/dav.js` | endpoint candidates, `PROPFIND` detection, `srcUrl()` for direct files |
| `electron/main.cjs` | `tailnetIp()`, the blob server, `tailscale status --json` |
| `android/.../DavPlugin.java` | the same `tailnetIp()` and blob server for Android |
| `src/bridge.js` | one API over Electron / Android / browser, incl. `tailscale()` |
| `.env` | your tailnet addresses (gitignored — see `.env.example`) |

---

---

## Using it

| Action | How |
|---|---|
| Send | `Enter`. `Shift+Enter` makes a new line |
| Send on the phone | tap `SEND`. `Enter` there makes a new line, like Telegram |
| Paste an image | `Ctrl+V` in the box, or the `PASTE` button |
| Choose where files go | the `CLOUD ☁` / `DIRECT ⇄` button |
| Attach | `+ FILE`, or drag files onto the window |
| Tag while writing | the `tags` box, or write `#tag` inside the message |
| Tag after sending | `#` on the message, type, Enter. Works on any message, any type |
| Reply | `↩` on the message. Click a quote to jump to the original |
| Delete a message | `×` |
| Search | `Ctrl+F`, or click any tag |
| Search everywhere | toggle `HERE` -> `ALL` |
| Filter by type | `ALL · MEDIA · FILES · LINKS · TEXT` under the chat name |
| New chat | `+ CHAT` in the sidebar |
| Rename / recolour / delete a chat | double click it, or `EDIT` |
| Save a file | click it. Desktop -> Downloads. Android -> share sheet |
| Light theme | `⚙` |

### Cloud or direct

The button next to `PASTE` picks how the *next* file travels. Text always goes through Nextcloud.

**`CLOUD ☁`** — the file is uploaded. Fire and forget. It is there whether your machine is on or not.
This is the default.

**`DIRECT ⇄`** — nothing is uploaded. The message carries only the name, the size and a one-time
token. The bytes stay on the sending device. The other end pulls them when you ask for the file.

Direct is right for big files:

* nothing lands on Nextcloud, so the disk there stays free
* one hop, not two. Nextcloud gave me 9.5 MB/s; a direct pull is limited by your network instead
* the file is never copied anywhere you did not choose

The cost: **the sending device has to be awake and running TSDROP.** If it is not, the
other end sees `<device> is offline — open TSDROP there`. Nothing is lost, you just open the app there.

Direct files show a `⇄` next to the size. They are not AES wrapped even in a private chat —
they never rest on a server, and WireGuard already encrypts the hop.

The desktop app lives in the tray, so it serves almost always. A phone only serves while the app
is open, which matches the way you would use it: open the app, hand the file over.

### Media

Images show in the chat by themselves, up to 24 MB.
Video and audio up to 96 MB get a `▶` button, press it to play in place.
Anything bigger stays a plain row, click to save it.

`MEDIA` finds images, video and audio. `FILES` finds everything else.
`LINKS` finds messages containing a URL. `TEXT` finds messages with no attachment.

---

## Private chats

Tick **private** when you create a chat and give it a password.

That chat is then real encryption, not a setting on the server:

* key: PBKDF2-SHA256, 250 000 rounds, from your password and a random salt
* content: AES-256-GCM, on this device, before anything is sent
* message text, tags, reply quotes and the real file names are all inside the ciphertext
* file bytes are encrypted while streaming, so size still does not matter
* on the server the file names are random junk and the bodies are noise
* decrypted messages are never written to disk, they live in memory only

The wire format is `[12B IV][ciphertext][16B tag]` and all three implementations
(Node in Electron, WebCrypto in the UI, Java on Android) read each other's bytes.
`npm run selftest` proves it.

**No recovery.** Lose the password and the data is gone. There is no reset.

Two limits, on purpose:

* a chat is private or not from the moment it is created. To change it, make a new chat.
* the chat *name* stays readable on the server. Only the contents are encrypted.

Unlock asks once per app start. Tick **remember on this device** to keep the key
in local storage instead. `EDIT` on the chat has **lock now / forget key**.

---

## Authenticator — your 2FA codes

The **◈** button in the top strip (also **◈ AUTHENTICATOR** at the bottom of the container
list) is a replacement for Google Authenticator that lives in your own cloud.

It has a password of its own. Not the Nextcloud one, not a container one — one more
password, on purpose, so that reaching the server, or reading a backup of it, is still not
enough to get a code.

Everything is in one file, `vault/vault.json` on the server:

```
{ v, salt, it, check, rev, ts, d }      d = AES-256-GCM( { entries: [...] } )
```

* key: PBKDF2-SHA256, **600 000** rounds (chats use 250 000) from the password and a random salt
* the blob holds the secrets *and* the account names — the server sees neither, only noise
* the key is in memory only, never local storage, never disk
* it is forgotten **5 minutes** after you last touch the vault, even with the pane closed,
  and by **LOCK**, and by closing the app
* codes are computed on the device; nothing is ever asked of the network to show one

Adding codes, in order of how little typing they need:

1. **Google Authenticator → ⋯ → Transfer accounts → Export.** That one QR holds every
   account. Screenshot it (or photograph the phone from the desktop) and feed the picture to
   **+ CODE → QR from image / QR from clipboard**. The whole list imports in one go.
2. Paste an `otpauth://totp/…` link — what a site's "can't scan the QR?" link gives you.
3. **type it in** — the base32 secret a site prints beside its QR.

Re-importing the same export twice is safe: an account already in the vault is skipped, not
duplicated.

Tap a code to copy it. Right-click (long-press) a row for rename, delete, and **copy otpauth
link** — that last one puts a plain secret on the clipboard, so it asks first; it is there
for moving an account to another app or to paper.

Both standards are implemented, against their own published test vectors:
TOTP (RFC 6238) and HOTP (RFC 4226), SHA1/SHA256/SHA512, 6–8 digits, 30s or 60s.
`node src/totp.test.mjs` runs all 28 of them.

Two devices can add codes at the same time without either losing one: every write re-reads
the file and merges by entry id, and a delete leaves a tombstone behind so it cannot come
back from the other phone. `node src/vault.test.mjs` plays that out, including a rekey.

**No recovery.** Lose the vault password and the codes are gone. Keep the one-time backup
codes your accounts handed you somewhere that is not this app — a vault that is your only
way in is a single point of failure, whoever wrote it.

QR reading uses the browser's own decoder on Android. Chromium has none on Linux, so the
desktop shells out to **zbar** (`sudo pacman -S zbar`); without it, paste the link instead.

## When every server is down: the MEGA copy

Containers, folders and the vault switched to **Back up to MEGA** go there every hour,
encrypted on the server first (`celephais-tsdrop-offsite`, in Cloud_infrastructure). That
copy is a restic repository of its own, `tsdrop-restic`, and the app can read it back.

* The server leaves `/.offsite.json` in TSDROP's root: a **read-only MEGA folder link** to the
  repository and its restic password. Every device copies it whenever it reaches a server.
* When no server answers, the app opens the newest snapshot straight from MEGA. Everything
  backed up is there, pictures and files included, **read only**: the composer is hidden,
  any change is refused, and the servers are retried every 20 seconds.
* Settings → MEGA backup → **Open the MEGA backup** does the same by hand, to check it works.
* **A device that never met the server** (a new phone after the server is gone) can take the
  link and password typed in by hand: Settings → MEGA backup → **Enter details by hand**. A
  fresh install with no server password shows that form straight away. The details are checked
  against the backup and kept only if it opens; from then on the device opens the backup by
  itself, and finds the server again once a server password is entered.
* The link cannot delete anything, and the password opens TSDROP's repository only, not
  the cloud share's backups. Keep both (`/etc/celephais/tsdrop-restic.*` on the host) outside
  TSDROP as well, on paper for instance: the vault is inside this backup, so it cannot be the
  only place that holds the key to it.

`src/restic.js` reads the repository format (scrypt key, AES-256-CTR + Poly1305-AES, zstd,
packs read by range; reads asked for together come down as one range per pack).
`src/offsite.test.mjs` builds a repository by the format spec and reads it back.

---

## Develop

```bash
cp .env.example .env   # put your own tailnet addresses in it
npm install
npm start              # vite + electron with hot reload
```

Keep the checkout on a local disk. On a CIFS/SMB share `npm install` cannot create the symlinks
in `node_modules/.bin`, and an Electron binary started from one comes up without ever opening a
window.

The selftest runs end to end against your live Nextcloud, so it needs credentials:

```bash
DAV_ENDPOINTS=http://100.x.y.z:8080/remote.php/dav/files/<user>/file-transfer-app \
DAV_USER=<user> DAV_PASS=<app-password> npm run selftest
```

Build:

```bash
npm run dist:linux                        # AppImage + deb + pacman
npm run dist:arch                         # pacman only, on the system electron
npm run dist:win                          # installer + portable exe (needs wine on Linux)
cd android && ./gradlew assembleRelease   # signed apk
```

Everything lands in `release/`, except the apk (`android/app/build/outputs/apk/release/`).

Android needs JDK 21 and the Android SDK:

```bash
mise install java@temurin-21          # or any other JDK 21
export JAVA_HOME=$HOME/.local/share/mise/installs/java/temurin-21
export ANDROID_HOME=$HOME/Android/Sdk
```

The SDK itself, if the machine has none, is Google's command line tools unpacked into
`$ANDROID_HOME/cmdline-tools/latest`, then:

```bash
yes | $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses
$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager platform-tools "platforms;android-36" "build-tools;36.0.0"
```

---

## Files that matter

| File | What |
|---|---|
| `src/App.jsx` | the whole UI |
| `src/store.js` | chats, messages, search |
| `src/dav.js` | WebDAV calls + endpoint detection |
| `src/bridge.js` | one API over Electron / Android / browser |
| `electron/main.cjs` | window, tray, Ctrl+Insert, streamed transfers |
| `electron/omarchy.cjs` | reads the desktop's theme and font, and watches both |
| `src/omarchy.js` | that palette mapped onto the HUD's variables |
| `omarchy/tsdrop.lua` | the Hyprland window rule and key binding |
| `android/app/src/main/java/net/tsdrop/app/DavPlugin.java` | all Android HTTP: WebDAV, streamed transfers, AES-GCM |
| `src/crypto.js` | AES-GCM + PBKDF2 in the UI |
| `src/totp.js` | TOTP/HOTP, otpauth links, the Google Authenticator export format |
| `src/vault.js` | the authenticator vault: one encrypted file, merges, auto-lock |
| `src/Vault.jsx` | its pane — codes, import, rename, password change |
| `src/Media.jsx` | inline images, video, audio |
| `electron/gcm.cjs` | the same crypto as a Node stream |
| `selftest.mjs` | the check, including crypto interop |
| `src/totp.test.mjs` | the RFC vectors (`npm test`) |
| `src/vault.test.mjs` | the vault against a fake server (`npm test`) |
| `src/offsite.js` | the MEGA copy as a read-only server, when none answers |
| `src/restic.js` | reads a restic repository: keys, index, trees, file bytes |
| `src/offsite.test.mjs` | that reader against a repository built by the spec (`npm test`) |

No credentials are in this repo. The Nextcloud app password is typed on first run and kept in
local storage on that device; your tailnet addresses come from `.env`, which is gitignored.

Anyone who can reach your tailnet *and* has the app password can read the shared chats — that
is the point, they are your own devices. Private chats and the authenticator vault are the
exception: those need their own password on top, and the server only ever sees noise.
