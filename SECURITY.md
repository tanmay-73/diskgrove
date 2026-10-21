# Security

## Reporting a vulnerability

Use [private vulnerability reporting](https://github.com/tanmay-73/diskgrove/security/advisories/new)
if enabled. Otherwise, open an issue requesting a private contact without exploit
details. Include the version, OS, reproduction steps and impact in the private report.

There is no guaranteed response time. Fixes target current source and the next
release; older versions have no promised backports.

## Boundaries

DiskGrove runs with the user's filesystem permissions. Avoid administrator or root
access for routine scans.

The renderer is sandboxed with context isolation, Node integration disabled and
a narrow preload API. IPC checks the sender window, top-level frame and app
document, then validates arguments. Navigation, popups and webviews are denied,
and so is every web permission except sanitized clipboard writes, which **Copy
path** uses. Production builds inject a CSP and block HTTP, HTTPS
and WebSocket requests in the Electron session. Development uses a local Vite
server with no CSP and no request blocking.

Opening and deletion require a main-process native dialog with Cancel as the
default. Paths must belong to the current scan. Before file actions, DiskGrove
rechecks file identity and ancestors and refuses traversal through symbolic
links or junctions. A scanned link itself may be deleted without deleting its
target. Scan and filesystem operations cannot overlap through IPC.

The preview pane reads only regular files in the current scan, after the same
identity check, and at most 16 MiB per request. Images, video and audio stream
through a private `diskgrove-media:` scheme with `nosniff` and a CSP that
blocks scripts. PDFs render with PDF.js in a worker with XFA forms disabled.
Office documents and ZIP archives are parsed in the renderer and shown as text
and tables; their contents never become HTML or script.

HTML reports escape data and apply a CSP. CSV cells with formula-like prefixes
are escaped. Reports and settings are written to exclusive temporary files and
renamed into place, with POSIX mode 0600; Windows uses the destination folder's
ACLs. Settings writes are serialized.

The uninstallers run with the user's permissions and delete fixed per-user
locations only. Settings are kept unless the user chooses to remove them or
passes `--delete-app-data`. The macOS and Linux script lists its targets and
asks before deleting, refuses to run unattended without `-y`, removes an app
bundle only if its `Info.plist` carries DiskGrove's bundle identifier, and
accepts a path argument only for such a bundle or a file named `*.AppImage`. It
never removes the .deb package; it tells the user to run `apt remove` instead.

The packaging configuration disables Electron's generic Node runtime,
`NODE_OPTIONS` and CLI inspection fuses, restricts code loading to ASAR and
enables embedded ASAR integrity checks where Electron supports them. Keep
Electron updated. It and the libraries Vite bundles into the renderer are listed
as development dependencies but ship in the app, so an audit with `--omit=dev`
misses them.

## Limits

- Identity checks are not atomic with file actions. A local writer can still race
  them. Recursive deletion includes current contents, including hidden, unreadable
  or newly added entries.
- Opening a file invokes its OS handler and can execute a program.
- Previews parse untrusted file content with PDF.js and Chromium's image and
  media decoders. A flaw in one of them could be reached by selecting a crafted
  file; the renderer sandbox limits what it can do.
- Duplicate results are snapshots of content hashes. Files can change afterward;
  hard links and reflinks can overstate recoverable space.
- Network mounts and OS handlers may access the network outside Electron's
  session. The app has no telemetry, accounts or automatic update service.
- Reports include full paths, and settings retain recent scan paths. Neither is
  encrypted by DiskGrove. Review exports before sharing them. Settings stay on
  disk after uninstalling unless you choose to remove them.
- The uninstall script finds AppImages by file name (`DiskGrove-*.AppImage`) in
  common folders of the home directory and closes processes named `diskgrove`
  (`DiskGrove` on macOS). Check the list it prints before confirming.
- Very large scans can exhaust memory or slow the UI.
- On Linux, Chromium's process sandbox needs unprivileged user namespaces. Where
  they are unavailable, the AppImage launcher starts DiskGrove with
  `--no-sandbox`, as other Electron AppImages do; context isolation, the preload
  boundary and IPC validation still apply. The .deb keeps the sandbox there by
  making `chrome-sandbox` setuid root at install time, and on Ubuntu 24.04 and
  later installs an AppArmor profile that allows DiskGrove user namespaces.
- Releases are not code-signed or notarized, so the operating system cannot
  verify the publisher. The `.sha256` files only detect corrupted downloads,
  since they are published alongside the installers. Development builds do not
  provide the same protections as packaged releases.
