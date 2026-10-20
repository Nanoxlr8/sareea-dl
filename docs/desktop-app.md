# The desktop app

* **Main window.** Toolbar (Add URL, Resume, Pause, Delete, Delete with file, Start queue, Stop queue,
  Details, Settings), category sidebar (All, Compressed, Documents, Music, Programs, Video, Unfinished,
  Finished; by file extension), sortable table (name, size, progress bar, %, speed, time left, status,
  added), multi-select (click, Ctrl, Shift, Ctrl+A), right-click menu (Open, Open folder, Copy link,
  Pause, Resume, Redownload, Details, Delete, Delete with file), drag a link onto the window to add it.
  Keys: `Ctrl+V` add from clipboard, `Del` delete (`Shift+Del` with file), `Enter` open or details.
* **Add dialog.** Reads an http(s) link from the clipboard if there is one, probes it (name, size,
  resume support), folder (default or Browse), connections 1 to 16, Start now or Add to queue.
  "Add to queue" keeps the item paused (status Queued) until Start queue.
* **Detail panel.** One coloured block per slice of the file, filled as bytes arrive, with the current
  connections visible as the engine splits work (IDM style), a bar per connection, a speed graph, and
  transfer details (size, done, speed, time left, save path, link, notes from the engine).
* **Settings.** Default folder (default `%USERPROFILE%\Downloads\Sareea`), per-category subfolders,
  simultaneous downloads (1 to 10), default connections (1 to 16), global speed limit (KB/s),
  start with Windows (off), theme (system, light, dark), language (English, Arabic with RTL layout),
  close to tray, completion notifications, clipboard watch (off), start browser downloads without asking
  (off). Changes apply at once.
* **Tray.** Menu: Show, Pause all, Resume all, Quit. Closing the window hides it to the tray (setting).
  Quit pauses everything cleanly and saves first. A second launch just shows the running window.
* **Notifications.** A Windows notification when a download completes (click: open its folder), and,
  with clipboard watch on, when a link to a downloadable file type is copied (click: open the Add dialog).
* **Persistence.** `%APPDATA%\Sareea DL\` holds `queue.json` (the phase-1 Queue file: the list and
  history), `settings.json`, `meta.json` (which items are "Queued"), and `logs\`. Downloads that were
  running when the app stopped come back **paused**; Resume continues from the saved segments.
* **Mark of the Web.** Finished files get a `Zone.Identifier` stream (zone 3, link origin and path),
  so SmartScreen and Office treat them as downloaded from the internet.

## Local bridge for the browser extension

The app listens on `\\.\pipe\sareea-dl-<username>`: newline-delimited JSON, request
`{v:1, id, type:"add"|"ping", url, fileName?, referrer?, headers?{cookie?, userAgent?}, pageUrl?}`,
reply `{v:1, id, ok, error?}`. An "add" opens the Add dialog prefilled for the user to confirm, unless
"Start browser downloads without asking" is on. Cookies stay in memory for that one download.
The browser reaches it through the native-messaging host `sareea-dl-host.exe`
([docs/extension.md](extension.md)). Full description, limits and examples: [docs/protocol.md](protocol.md).
