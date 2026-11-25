# Vertical Tabs Lite

An Obsidian plugin that lists your open notes vertically in the sidebar, like vertical tabs in a browser.

![Vertical Tabs Lite preview](docs/preview.png)

Requires Obsidian 1.13.0 or newer. Desktop only.

## Features

- **Vertical tab list** in the left or right sidebar, with the active tab highlighted
- **Colours**
  - Give any tab a colour: right-click → **Colour…**, or run **Set colour of current tab**
  - Show colours as a dot, a side stripe, a background tint, or a coloured title
  - **Colour by folder**: every note in the same folder gets the same colour automatically
  - Choose how the active tab stands out (soft tint, solid colour, or side bar only), with your theme's accent colour or one you pick
- **Customise each tab**
  - **Tab title**: file name, the note's frontmatter `title`, or its first heading
  - **Second line**: folder, full path, when it was last edited, or nothing
  - **Text size** (80–130%) and **corner roundness** sliders
  - Wrap long titles onto more lines, show file extensions for non-notes
- **Filter box**: type to narrow by title or folder, Enter opens the first match, Esc clears
- **Tab count** in the filter box and next to each pane heading
- **Page preview** on hover (hold Cmd/Ctrl, configurable in the core *Page preview* settings)
- **Grouped by pane** when the editor is split; click a pane heading to collapse it
- **Tab limit**: optionally close the least recently used tabs once you have more than a set number open (pinned tabs are kept)
- **Pinned tabs** stay on top and are skipped by "Close others" / "Close all"
- **Right-click menu**: Pin/Unpin, Colour…, Duplicate tab, Open to the right, Open in new window, Reveal in file explorer, Copy path, Close, Close others, Close tabs below, Close all, Reopen closed tab
- **Middle-click** to close a tab, **+** button or **double-click** empty space for a new tab
- **Commands** (bind to any hotkey):
  - Go to next tab / Go to previous tab
  - Go to tab 1–8, Go to last tab
  - Pin or unpin current tab
  - Set colour of current tab
  - Filter open tabs
  - Close all unpinned tabs
  - Toggle native tab bar
- **Optional**: hide Obsidian's horizontal tab bar

## Install (manual)

1. Download `main.js`, `manifest.json` and `styles.css` from the latest release.
2. Copy those three files into `<your vault>/.obsidian/plugins/vertical-tabs-lite/`.
3. In Obsidian, open **Settings → Community plugins** and enable **Vertical Tabs Lite**.

## Build

```bash
npm install
npm run build   # one-off production build
npm run dev     # rebuild on save
```

## Settings

| Section | Setting | Default | What it does |
|---|---|---|---|
| Placement | Sidebar | Left | Which sidebar the list lives in |
| | Open on startup | On | Open the list when Obsidian starts |
| | Hide native tab bar | Off | Hide the horizontal tabs above your notes |
| Appearance | Density | Comfortable | Compact, Comfortable or Spacious rows |
| | Show icons | On | File-type icon next to each tab |
| | Tab title | File name | File name, Frontmatter title, or First heading |
| | Second line | Folder | Folder, Full path, Last edited, or Nothing |
| | Show file extensions | Off | Show `.pdf`, `.canvas` etc. for files that aren't notes |
| | Wrap long titles | Off | Let long titles take more than one line |
| | Text size | 100% | 80–130% |
| | Corner roundness | 6 | 0 (square) to 14 (very round) |
| | Show filter box | On | Search box above the list |
| | Show new tab button | On | The **+** button next to the filter box |
| | Show tab count | On | Number of open tabs in the filter box and pane headings |
| | Close button | On hover | When to show the ×: on hover, always, or never |
| Colours | Active tab style | Soft tint | Soft tint, Solid colour, or Side bar only |
| | Custom accent colour | Off | Use your own colour for the active tab instead of the theme accent |
| | Accent colour | Purple | The colour to use (shown when the option above is on) |
| | Colour label style | Dot | How a tab's colour shows: Dot, Side stripe, Background tint, or Coloured title |
| | Colour by folder | Off | Colour every tab by its folder; colours you pick still win |
| | Clear tab colours | — | Remove all the colours you've picked |
| Order and grouping | Sort tabs by | Obsidian's order | Obsidian's tab order, Title (A–Z), Folder, Recently used, or Last edited |
| | Pinned tabs first | On | Keep pinned tabs at the top |
| | Group by pane | On | Heading per pane when the editor is split (click to collapse) |
| Behaviour | Middle-click closes tab | On | Close a tab with the mouse wheel |
| | Double-click opens new tab | On | Double-click empty space below the tabs |
| | Tab limit | 0 (off) | Close least recently used unpinned tabs beyond this many |
| | Confirm before closing all | On | Ask before "Close all" |

A **Reset to defaults** button restores everything except "Hide native tab bar" and your tab colours.

Tab colours follow a note when you rename or move it, and are forgotten when you delete it.
