#!/bin/sh
# Uninstalls DiskGrove on macOS and Linux: the app itself plus the caches and,
# if wanted, the settings it leaves in the home directory. Windows uses the NSIS
# uninstaller. The Linux .deb package is removed with apt, which this script
# leaves to the user because it needs root.
#
#   sh uninstall.sh [-y] [--delete-app-data] [path to DiskGrove.app or the AppImage]

set -u

APP_NAME=DiskGrove
APP_ID=io.github.tanmay-73.diskgrove
# Electron names its data directory after the package name.
DATA_NAME=diskgrove

usage() {
  echo "Usage: sh uninstall.sh [-y] [--delete-app-data] [path to $APP_NAME.app or the AppImage]"
  echo "  -y, --yes           remove without asking; settings are kept"
  echo "  --delete-app-data   remove the settings too, without asking about them"
}

assume_yes=0
delete_app_data=0
app_path=
while [ $# -gt 0 ]; do
  case $1 in
    -y | --yes) assume_yes=1 ;;
    --delete-app-data) delete_app_data=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *) app_path=$1 ;;
  esac
  shift
done

if [ -z "${HOME:-}" ] || [ ! -d "$HOME" ]; then
  echo "HOME is not set to a directory." >&2
  exit 1
fi

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)

# Newline-separated, with a leading newline so whole entries can be matched.
targets='
'
add() {
  if [ -e "$1" ] || [ -L "$1" ]; then
    case $targets in
      *"
$1
"*) ;;
      *) targets="$targets$1
" ;;
    esac
  fi
}

# Only bundles that identify themselves as DiskGrove are removed.
is_app_bundle() {
  [ -d "$1" ] && grep -qF "<string>$APP_ID</string>" "$1/Contents/Info.plist" 2>/dev/null
}

add_bundle() {
  if is_app_bundle "$1"; then add "$1"; fi
}

add_appimages() {
  for file in "$1/$APP_NAME"-*.AppImage; do
    if [ -f "$file" ]; then add "$file"; fi
  done
}

note=
deb_installed=0
case $(uname -s) in
  Darwin)
    process_name=$APP_NAME
    if [ -n "$app_path" ]; then
      if ! is_app_bundle "$app_path"; then
        echo "Not a $APP_NAME app bundle: $app_path" >&2
        exit 2
      fi
      add "$app_path"
    else
      # the copy this script ships in, wherever it was installed
      case $script_dir in
        *.app/Contents/Resources) add_bundle "${script_dir%/Contents/Resources}" ;;
      esac
      add_bundle "/Applications/$APP_NAME.app"
      add_bundle "$HOME/Applications/$APP_NAME.app"
    fi
    library=$HOME/Library
    data_dir="$library/Application Support/$DATA_NAME"
    add "$data_dir"
    add "$library/Caches/$APP_ID"
    add "$library/HTTPStorages/$APP_ID"
    add "$library/HTTPStorages/$APP_ID.binarycookies"
    add "$library/Logs/$DATA_NAME"
    add "$library/Preferences/$APP_ID.plist"
    add "$library/Saved Application State/$APP_ID.savedState"
    ;;
  Linux)
    process_name=$DATA_NAME
    if dpkg-query -W -f='${Status}' "$DATA_NAME" 2>/dev/null | grep -q ' installed$'; then
      deb_installed=1
    fi
    if [ -n "$app_path" ]; then
      case $app_path in
        *.AppImage) ;;
        *)
          echo "Not an AppImage: $app_path" >&2
          exit 2
          ;;
      esac
      if [ ! -f "$app_path" ]; then
        echo "No such file: $app_path" >&2
        exit 2
      fi
      add "$app_path"
    else
      found=$targets
      # next to a copy of this script extracted from the AppImage
      case $script_dir in
        */squashfs-root/resources) add_appimages "${script_dir%/squashfs-root/resources}" ;;
      esac
      for dir in "$HOME/Applications" "$HOME/.local/bin" "$HOME/Downloads" "$HOME/Desktop" "$HOME"; do
        add_appimages "$dir"
      done
      if [ "$found" = "$targets" ] && [ "$deb_installed" -ne 1 ]; then
        note="The AppImage was not found. Delete it yourself, or pass its path to this script."
      fi
    fi
    data_dir=${XDG_CONFIG_HOME:-$HOME/.config}/$DATA_NAME
    add "$data_dir"
    add "${XDG_CACHE_HOME:-$HOME/.cache}/$DATA_NAME"
    # menu entries and icons registered by AppImageLauncher or appimaged
    data_home=${XDG_DATA_HOME:-$HOME/.local/share}
    for file in "$data_home"/applications/appimagekit_*-"$APP_NAME".desktop \
      "$data_home"/icons/hicolor/*/apps/appimagekit_*_"$DATA_NAME".*; do
      add "$file"
    done
    ;;
  *)
    echo "This script supports macOS and Linux only." >&2
    exit 1
    ;;
esac

if [ "$targets" = '
' ]; then
  echo "No $APP_NAME files were found for this user. Nothing to remove."
  if [ -n "$note" ]; then echo "$note"; fi
  if [ "$deb_installed" -eq 1 ]; then echo "Remove the $APP_NAME package with: sudo apt remove $DATA_NAME"; fi
  exit 0
fi

if [ "$assume_yes" -ne 1 ] && [ ! -t 0 ]; then
  echo "Not attached to a terminal. Run again with -y to confirm." >&2
  exit 1
fi

ask() {
  printf '%s [y/N] ' "$1"
  read -r reply || reply=
  case $reply in
    y | Y | yes | YES) return 0 ;;
    *) return 1 ;;
  esac
}

# The data directory holds settings.json next to caches that always go.
settings=$data_dir/settings.json
keep_settings=0
if [ -f "$settings" ] && [ "$delete_app_data" -ne 1 ]; then
  keep_settings=1
  if [ "$assume_yes" -ne 1 ] && ask "Also remove your $APP_NAME settings and recent scans?"; then
    keep_settings=0
  fi
fi

echo "This will permanently remove:"
set -f
IFS='
'
for target in $targets; do
  if [ "$keep_settings" -eq 1 ] && [ "$target" = "$data_dir" ]; then
    echo "  $target (except settings.json)"
  else
    echo "  $target"
  fi
done
unset IFS
set +f
if [ "$assume_yes" -ne 1 ] && ! ask "Continue?"; then
  echo "Cancelled."
  exit 1
fi

if pgrep -x "$process_name" >/dev/null 2>&1; then
  echo "Closing $APP_NAME..."
  pkill -x "$process_name" 2>/dev/null
  tries=0
  while pgrep -x "$process_name" >/dev/null 2>&1 && [ "$tries" -lt 10 ]; do
    sleep 1
    tries=$((tries + 1))
  done
  if pgrep -x "$process_name" >/dev/null 2>&1; then
    echo "$APP_NAME is still running. Close it and run this again." >&2
    exit 1
  fi
fi

# Deleting the plist alone would leave the preferences cached by the system.
if [ "$(uname -s)" = Darwin ]; then
  defaults delete "$APP_ID" >/dev/null 2>&1
fi

# Empties the data directory but leaves settings.json in it.
remove_caches() {
  set +f
  for entry in "$1"/* "$1"/.[!.]* "$1"/..?*; do
    if [ "$entry" != "$settings" ]; then rm -rf -- "$entry" 2>/dev/null; fi
  done
  set -f
  [ "$(ls -A -- "$1")" = settings.json ]
}

failed=0
set -f
IFS='
'
for target in $targets; do
  if [ "$keep_settings" -eq 1 ] && [ "$target" = "$data_dir" ]; then
    if remove_caches "$target"; then
      echo "Removed the caches in $target"
    else
      echo "Could not remove everything in $target" >&2
      failed=1
    fi
    continue
  fi
  rm -rf -- "$target" 2>/dev/null
  if [ -e "$target" ] || [ -L "$target" ]; then
    echo "Could not remove $target" >&2
    failed=1
  else
    echo "Removed $target"
  fi
done
unset IFS
set +f

# Clean up after `--appimage-extract resources/uninstall.sh`.
case $script_dir in
  */squashfs-root/resources)
    rm -f -- "$script_dir/uninstall.sh"
    rmdir -- "$script_dir" "${script_dir%/resources}" 2>/dev/null
    ;;
esac

if [ -n "$note" ]; then echo "$note"; fi
if [ "$failed" -ne 0 ]; then
  echo "Some items could not be removed. Delete them manually, with sudo if needed." >&2
  exit 1
fi
if [ "$deb_installed" -eq 1 ]; then
  echo "Removed the $APP_NAME files for this user."
else
  echo "$APP_NAME has been uninstalled."
fi
if [ "$keep_settings" -eq 1 ]; then echo "Your settings were kept in $settings"; fi
if [ "$deb_installed" -eq 1 ]; then echo "Remove the $APP_NAME package with: sudo apt remove $DATA_NAME"; fi
