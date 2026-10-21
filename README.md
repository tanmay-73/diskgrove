# DiskGrove

DiskGrove is a desktop disk space analyzer built with Electron, React and TypeScript.
Packaging targets Windows, macOS (beta) and Linux.

DiskGrove is free and open source, and works the same way on every platform it
supports. Everything stays on your computer: there is no account, telemetry or
cloud service. You can preview a file before deleting it, and nothing is opened
or deleted without your confirmation.

## What it does

- Browse folder sizes in a tree, table, treemap, pie chart or bar chart.
- Explore file extensions, modification ages and the largest files.
- Search file and folder names in the selected folder or across the entire scan.
  Plain text matches anywhere in a name; with `*` or `?` the whole name must
  match. Matching ignores case and Unicode normalization differences. Results
  update while a scan runs, and the largest 2,000 are listed with the total count.
  Press Ctrl+F (⌘F on macOS) to search.
- Find duplicate content using SHA-256, with full-file verification after sampling.
- Preview the selected file in a side pane: images, video, audio, PDF, text and code,
  CSV, Word, Excel, PowerPoint and ZIP contents, with dates, dimensions, duration and
  document properties. Previews are read-only and never run file content.
- Export CSV, JSON or a standalone HTML report.
- Reveal items in the file manager, open them, or move them to Trash / Recycle Bin.
  Permanent deletion is also available. Opening and deletion require a native
  confirmation dialog.

## Install

Download the installer for your system from
[Releases](https://github.com/tanmay-73/diskgrove/releases):

| System                      | File                                        |
| --------------------------- | ------------------------------------------- |
| Windows (x64)               | `DiskGrove-<version>-win-x64.exe`           |
| macOS (Apple silicon, beta) | `DiskGrove-<version>-mac-arm64.dmg`         |
| macOS (Intel, beta)         | `DiskGrove-<version>-mac-x64.dmg`           |
| Linux (x64)                 | `DiskGrove-<version>-linux-x86_64.AppImage` |
| Debian, Ubuntu (x64)        | `DiskGrove-<version>-linux-amd64.deb`       |

The macOS builds are in beta. Please report any problems in
[Issues](https://github.com/tanmay-73/diskgrove/issues).

Each file has a `.sha256` checksum beside it. Check a download with
`sha256sum -c <file>.sha256` on Linux, `shasum -a 256 -c <file>.sha256` on macOS,
or compare the output of `Get-FileHash <file>` in PowerShell on Windows.

The builds are not code-signed, so the operating system warns before the first
launch:

- **Windows:** SmartScreen shows "Windows protected your PC". Choose
  **More info**, then **Run anyway**.
- **macOS:** after dragging DiskGrove to Applications, macOS refuses to open it
  because it cannot verify the developer. Open **System Settings > Privacy &
  Security** and choose **Open Anyway** next to the DiskGrove message. If macOS
  instead reports that the app "is damaged", run
  `xattr -cr /Applications/DiskGrove.app` in Terminal and open it again.
- **Linux:** make the AppImage executable with
  `chmod +x DiskGrove-*.AppImage`. AppImages need FUSE 2, which Ubuntu 22.04 and
  later do not install by default: install `libfuse2t64` (Ubuntu 24.04 and later)
  or `libfuse2` (Ubuntu 22.04). Without it, run the AppImage with
  `APPIMAGE_EXTRACT_AND_RUN=1` set, which unpacks it to a temporary folder on
  each launch.
- **Debian and Ubuntu:** install the package with
  `sudo apt install ./DiskGrove-*-linux-amd64.deb`, which also installs its
  dependencies. DiskGrove then appears in the applications menu and runs as
  `diskgrove` from a terminal. It installs to `/opt/DiskGrove`.

## Development

Install Node.js 22.12 or newer (Node 24 LTS is used in CI) and npm, then:

```sh
npm ci
npm run dev
```

```sh
npm run check         # formatting, TypeScript and regression tests
npm run build        # compile main, preload and renderer into out/
npm audit            # include build tools, bundled libraries and the Electron runtime
```

Use `npm run format` to apply formatting.

## Packaging

```sh
npm run pack         # unpacked app in release/
npm run dist         # installer for the current platform
```

The configured targets are Windows NSIS, macOS DMG (Apple silicon and Intel,
in beta) and Linux AppImage and .deb. Build on the target operating system. Signing and
notarization are not configured, so local artifacts are unsigned. Pushing a
version tag builds all three in GitHub Actions; see
[Releasing](CONTRIBUTING.md#releasing).

The Windows installer registers an uninstaller and the .deb is removed with apt.
The macOS and Linux builds also bundle `resources/uninstall.sh`; see
[Uninstalling](#uninstalling).

## Uninstalling

Every uninstaller asks whether to remove your settings and recent scans too.
They live in `settings.json` in the data folder; the caches beside it always go.

On Windows, uninstall from **Settings > Apps** or run `Uninstall DiskGrove.exe`
in the install folder. This removes the program files, shortcuts, registry
entries, the cached installer in `%LOCALAPPDATA%\diskgrove-updater` and the
data folder `%APPDATA%\diskgrove`. A silent uninstall (`/S`) keeps the settings
unless `--delete-app-data` is passed. Installing a newer version over an existing
one keeps everything.

The macOS app and the AppImage have no installer, so they carry an uninstall
script instead. It lists what it will delete and asks before deleting. `-y` skips the
questions and keeps the settings; add `--delete-app-data` to remove them.

```sh
# macOS
sh /Applications/DiskGrove.app/Contents/Resources/uninstall.sh

# Linux, from the folder that holds the AppImage
./DiskGrove-1.0.0-linux-x86_64.AppImage --appimage-extract resources/uninstall.sh
sh squashfs-root/resources/uninstall.sh
```

On macOS this removes the app and its files under `~/Library` (the data folder
`Application Support/diskgrove`, caches, preferences, logs and saved window
state). On Linux it removes the AppImage, the data folder `~/.config/diskgrove`,
`~/.cache/diskgrove` and any menu entry added by AppImageLauncher or appimaged.
If the AppImage is somewhere the script does not look, pass its path as an
argument.

For the .deb package, run the bundled script first if you also want your data
removed, then remove the package. apt removes the program files, the menu entry,
the `diskgrove` command and the AppArmor profile, but not the data in your home
directory.

```sh
sh /opt/DiskGrove/resources/uninstall.sh
sudo apt remove diskgrove
```

## Scan behavior and limits

Scans are snapshots. Stopping a scan keeps the partial results: the status bar
and title bar mark them as partial, and the scan is not added to recent scans.
Rescan after changes outside DiskGrove.

Items DiskGrove cannot read, such as folders the account may not open, are left
out of the sizes. The status bar counts them; click the count to list them.
Folders that could not be read are marked in the tree and the details table.
Items deleted while the scan runs are not counted.

Symbolic links and junctions are skipped by default. Enabling **Follow links**
includes their targets and stops directory cycles. Shared targets may be counted
more than once. File actions through linked directories are refused; scan the
target directly to manage those files.

On Linux, kernel virtual filesystems such as `/proc` and `/sys` are listed but
not scanned unless one is chosen as the scan root: their files report sizes that
are not stored anywhere. On macOS, `/dev` is treated the same way, and folders
that the system volume shares with `/System/Volumes/Data` are counted once, under
their usual paths such as `/Users`.

Allocated size uses filesystem block counts where available and otherwise
estimates with 4 KiB blocks. Duplicate savings are estimates: hard links,
compression and reflinks can make the actual recoverable space smaller. Scans
keep metadata in memory: about 250 MB of RAM per million files and folders.

The app has no telemetry or cloud service. Recent scan paths are saved locally
in Electron's user-data directory and stay there after uninstalling unless you
choose to remove them. Reports contain filenames and full paths; review them
before sharing.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the source layout, checks and manual
test procedure. Security boundaries and reporting instructions are in
[SECURITY.md](SECURITY.md).

Licensed under [MIT](LICENSE).

UI components are adapted from [shadcn/ui](https://github.com/shadcn-ui/ui).
See [third-party notices](THIRD_PARTY_NOTICES.md) for the upstream copyright
and license. Packaged builds also include `THIRD_PARTY_LICENSES.txt`, which lists
every bundled library with its license.
