# Vertical Tabs Lite

An Obsidian plugin that lists your open notes vertically in the sidebar, like vertical tabs in a browser.

![Vertical Tabs Lite preview](docs/preview.png)

## Features

- **Vertical tab list** in the left or right sidebar, with the active tab highlighted
- **Filter box**: type to narrow by title or folder, Enter opens the first match, Esc clears
- **Grouped by pane** when the editor is split
- **Pinned tabs** stay on top and are skipped by "Close others" / "Close all"
- **Folder label** under each title, full path on hover
- **Right-click menu**: Pin/Unpin, Open to the right, Reveal in file explorer, Copy path, Close, Close others, Close all
- **Middle-click** to close a tab, **+** button for a new tab
- **Commands** (bind to any hotkey): Go to next tab, Go to previous tab, Filter open tabs, Toggle native tab bar
- **Optional**: hide Obsidian's horizontal tab bar

## Install (manual)

1. Build it (see below), or download `main.js`, `manifest.json` and `styles.css` from a release.
2. Copy those three files into `<your vault>/.obsidian/plugins/vertical-tabs-lite/`.
3. In Obsidian, open **Settings → Community plugins** and enable **Vertical Tabs Lite**.

## Build

```bash
npm install
npm run build   # one-off production build
npm run dev     # rebuild on save
```

## Settings

| Setting | Default | What it does |
|---|---|---|
| Sidebar | Left | Which sidebar the list lives in |
| Show folder | On | Show each note's folder under its title |
| Hide native tab bar | Off | Hide the horizontal tab headers in the editor |
| Open on startup | On | Open the list when Obsidian starts |
