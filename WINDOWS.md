# airoom on Windows

Windows 11 x64 is a beta. The installer is at
[airoom.dev/download?os=windows](https://airoom.dev/download?os=windows), and
every release carries it as `airoom-x64.exe`. It is not code-signed yet, so
SmartScreen warns once per build: More info, then Run anyway.

## What is tested

The `windows` workflow (`.github/workflows/windows.yml`) runs on a real
Windows machine for every push and pull request to `main`: both typechecks,
the whole server suite (the lane tests drive real git), and the installer
build. A version tag attaches the installer to its release. The app itself
has had far less hands-on use on Windows than on macOS, and the browser pane
has only been tried on macOS.

## How it differs from macOS

- The window has no system frame. The caption buttons sit at the right of
  the topbar (`titleBarOverlay`), and the topbar is the drag handle.
- The tray shows an icon (`desktop/build/tray-win.png`) with the counts in its
  tooltip, since Windows has no tray text.
- Claude Code's native install is found at `%USERPROFILE%\.local\bin\claude.exe`
  without relying on PATH; otherwise airoom asks `where claude`.
- "Open in Claude Code" opens Windows Terminal when it is installed, and a
  console window when it is not.
- Paths go through `server/src/platform.ts`, which accepts both separators,
  drive letters and UNC paths.

## Not supported

- Claude Code inside WSL: its transcripts live in the Linux filesystem, where
  airoom does not look.
- ARM64 builds. The x64 installer runs under emulation on ARM Windows 11.
