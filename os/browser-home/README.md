# Browser start page

The PC OS packages a small, removable Chromium Manifest V3 extension. It opens on
New Tab and the browser's default startup, with one action: **Connections**.
The launcher registers it for the local user before opening Chromium, only when
their existing profiles have no custom New Tab extension. Each launch also checks
for later customizations or imported profiles; those restrict the descriptor to
updating existing installations only. Startup preferences, bookmarks and explicit
URLs stay untouched. A user can disable/remove it in `chrome://extensions` or
choose another New Tab extension. Chromium remembers removal across OS updates.

The extension is locally signed rather than published in the Chrome Web Store.
Chromium may flag its source in Extensions' Safety Check; that browser warning
is preserved, along with the controls to disable or remove it.

The extension has only `nativeMessaging` permission. It has no network access,
content scripts, history, tab or bookmark permissions. Clicking
Connections starts a short-lived native host which accepts only the Connections
action or install acknowledgment from the exact extension origin. The host
authenticates or starts the existing per-user Connections helper and opens its
temporary capability URL through the OS browser launcher. The page opens in a
new tab; no capability is sent back to the extension. There is
no fixed local port, unauthenticated credential endpoint or shell-command bridge.

On a never-used default profile only, a temporary headless Chromium process lets
the external extension install before the first visible window. An install-only
worker acknowledges readiness through the native host and a private user runtime
socket. The launcher then closes only that child through private CDP pipes; there
is no debugging port. Existing profiles, explicit URLs and custom-profile options
skip this step. Preparation is bounded and failure falls back to normal browsing.
The worker has no startup listener, timers or persistent connection.

The signed `home.crx` is committed alongside its source. Ordinary OS builds need
no private key or browser build. `os/tools/browser_home_payload.py` verifies the
CRX3 RSA signature, extension identity and every bundled file against the source
before packaging it. This uses OpenSSL only on the build/test host; the installed
bridge uses Python's standard library.

To change the page, increment `extension/manifest.json`'s version, then pack it
with Chromium using the existing **private** extension signing key:

```sh
chromium --user-data-dir=/tmp/harness-home-pack --no-message-box \
  --pack-extension="$PWD/os/browser-home/extension" \
  --pack-extension-key=/secure/path/harness-home.pem
mv os/browser-home/extension.crx os/browser-home/home.crx
chmod 644 os/browser-home/home.crx
python3 os/tools/browser_home_payload.py
```

Keep the private key in secure maintainer storage, backed up before publication;
never commit it or ship it in an image. Reuse the same key: changing it changes
the extension ID and loses the browser's remembered customization. Package
updates take effect on the next browser launch; never terminate a running browser
or rewrite a live browser profile to activate the page.

The experimental Fedora session does not yet include this browser integration.
Validate its native Chromium paths and removable install before adding it there.
