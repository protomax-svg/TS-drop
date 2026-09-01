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

Runs on Windows 10/11, Linux (Electron) and Android (Capacitor).

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

**Linux (Kubuntu)** — pick one:

```bash
sudo dpkg -i release/TSDROP-<version>-amd64.deb        # installs as `tsdrop`
# or
chmod +x release/TSDROP-<version>-x86_64.AppImage && ./release/TSDROP-<version>-x86_64.AppImage
```

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
* **Linux / Wayland** — the compositor decides where windows go, so the app cannot place itself.
  KDE will put it where it likes. Nothing to fix on our side.

Its size is remembered.

## Ctrl+Insert

Click the tray icon, or press **Ctrl+Insert**, to show and hide it.

Works out of the box on Windows and Linux/X11.

**KDE on Wayland blocks global hotkeys for apps.** The `.deb` ships the shortcut in its
desktop entry, so it should just work. If it does not:

> System Settings -> Keyboard -> Shortcuts -> Add Command -> `tsdrop` -> assign `Ctrl+Ins`

Launching `tsdrop` while it is already running toggles the window. That is what the shortcut uses.

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

## Develop

```bash
cp .env.example .env   # put your own tailnet addresses in it
npm install
npm start              # vite + electron with hot reload
```

The selftest runs end to end against your live Nextcloud, so it needs credentials:

```bash
DAV_ENDPOINTS=http://100.x.y.z:8080/remote.php/dav/files/<user>/file-transfer-app \
DAV_USER=<user> DAV_PASS=<app-password> npm run selftest
```

Build:

```bash
npm run dist:linux                        # AppImage + deb
npm run dist:win                          # installer + portable exe (needs wine on Linux)
cd android && ./gradlew assembleRelease   # signed apk
```

Everything lands in `release/`, except the apk (`android/app/build/outputs/apk/release/`).

Android needs JDK 21 and the Android SDK:

```bash
export JAVA_HOME=$HOME/.jdks/jdk-21.0.12.1+1
export ANDROID_HOME=$HOME/Android/Sdk
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
| `android/app/src/main/java/net/tsdrop/app/DavPlugin.java` | all Android HTTP: WebDAV, streamed transfers, AES-GCM |
| `src/crypto.js` | AES-GCM + PBKDF2 in the UI |
| `src/Media.jsx` | inline images, video, audio |
| `electron/gcm.cjs` | the same crypto as a Node stream |
| `selftest.mjs` | the check, including crypto interop |

No credentials are in this repo. The Nextcloud app password is typed on first run and kept in
local storage on that device; your tailnet addresses come from `.env`, which is gitignored.

Anyone who can reach your tailnet *and* has the app password can read the shared chats — that
is the point, they are your own devices. Private chats are the exception: those need their own
password on top, and the server only ever sees noise.
