import {
  App,
  FuzzySuggestModal,
  HoverParent,
  HoverPopover,
  ItemView,
  Menu,
  Modal,
  Plugin,
  PluginSettingTab,
  Setting,
  SettingDefinitionItem,
  TextComponent,
  TAbstractFile,
  TFile,
  WorkspaceLeaf,
  debounce,
  setIcon,
  setTooltip,
} from "obsidian";

const VIEW_TYPE = "vertical-tabs-lite";

type SortBy = "obsidian" | "manual" | "title" | "recent" | "folder" | "modified";
type GroupBy = "pane" | "folder" | "colour" | "none";

/** A heading in the list and the tabs under it. */
interface TabGroup {
  key: string;
  label: string;
  tooltip?: string;
  leaves: WorkspaceLeaf[];
}
type TitleSource = "name" | "frontmatter" | "heading";
type Subtitle = "folder" | "path" | "modified" | "none";
type CloseButton = "hover" | "always" | "never";
type Density = "slim" | "compact" | "comfortable" | "spacious";
type ActiveStyle = "tint" | "solid" | "bar";
type LabelStyle = "dot" | "bar" | "tint" | "text";

/** Colour names map to Obsidian's theme colours (var(--color-<name>)). */
const COLORS = ["red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink"] as const;
type ColorName = (typeof COLORS)[number];
const COLOR_LABELS: Record<ColorName, string> = {
  red: "Red",
  orange: "Orange",
  yellow: "Yellow",
  green: "Green",
  cyan: "Cyan",
  blue: "Blue",
  purple: "Purple",
  pink: "Pink",
};
const isColor = (v: unknown): v is ColorName =>
  typeof v === "string" && (COLORS as readonly string[]).includes(v);

interface VTSettings {
  // Placement
  side: "left" | "right";
  shareSidebar: boolean;
  openOnStartup: boolean;
  hideNativeTabs: boolean;
  // Appearance
  density: Density;
  showIcons: boolean;
  titleSource: TitleSource;
  subtitle: Subtitle;
  showExtension: boolean;
  wrapTitles: boolean;
  textScale: number;
  cornerRadius: number;
  showFilter: boolean;
  showNewTabButton: boolean;
  showTabCount: boolean;
  closeButton: CloseButton;
  // Colours
  activeStyle: ActiveStyle;
  useCustomAccent: boolean;
  accentColor: string;
  labelStyle: LabelStyle;
  colorByFolder: boolean;
  tabColors: Record<string, ColorName>;
  // Order & grouping
  sortBy: SortBy;
  pinnedFirst: boolean;
  groupBy: GroupBy;
  /** File paths in the order the user dragged them ("My order"). */
  manualOrder: string[];
  /** Custom names for tabs, by file path. */
  nicknames: Record<string, string>;
  // Behaviour
  middleClickClose: boolean;
  doubleClickNewTab: boolean;
  confirmCloseAll: boolean;
  tabLimit: number;
  // Extras
  showRecentlyClosed: boolean;
  recentlyClosedCount: number;
  showStatusBar: boolean;
  tabSets: Record<string, string[]>;
}

const DEFAULT_SETTINGS: VTSettings = {
  side: "left",
  shareSidebar: false,
  openOnStartup: true,
  hideNativeTabs: false,
  density: "comfortable",
  showIcons: true,
  titleSource: "name",
  subtitle: "folder",
  showExtension: false,
  wrapTitles: false,
  textScale: 100,
  cornerRadius: 6,
  showFilter: true,
  showNewTabButton: true,
  showTabCount: true,
  closeButton: "hover",
  activeStyle: "tint",
  useCustomAccent: false,
  accentColor: "#7c5cff",
  labelStyle: "dot",
  colorByFolder: false,
  tabColors: {},
  sortBy: "obsidian",
  pinnedFirst: true,
  groupBy: "pane",
  manualOrder: [],
  nicknames: {},
  middleClickClose: true,
  doubleClickNewTab: true,
  confirmCloseAll: true,
  tabLimit: 0,
  showRecentlyClosed: true,
  recentlyClosedCount: 5,
  showStatusBar: false,
  tabSets: {},
};

/** All tabs in the main editor area, grouped by their tab group (split pane). */
function getGroups(app: App): WorkspaceLeaf[][] {
  const groups = new Map<unknown, WorkspaceLeaf[]>();
  app.workspace.iterateRootLeaves((leaf) => {
    const key = leaf.parent ?? leaf;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(leaf);
  });
  return [...groups.values()];
}

/** Flatten one level of nesting (avoids Array.prototype.flat for older targets). */
function flatten<T>(lists: T[][]): T[] {
  const out: T[] = [];
  for (const list of lists) out.push(...list);
  return out;
}

function leafFile(leaf: WorkspaceLeaf): TFile | null {
  const file = (leaf.view as { file?: TFile }).file;
  return file instanceof TFile ? file : null;
}

const isPinned = (leaf: WorkspaceLeaf) => !!leaf.getViewState().pinned;

/** "just now", "5 minutes ago", "yesterday", "3 days ago", then a date. */
function timeAgo(ms: number): string {
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return plural(min, "minute");
  const hr = Math.round(min / 60);
  if (hr < 24) return plural(hr, "hour");
  const day = Math.round(hr / 24);
  if (day === 1) return "yesterday";
  if (day < 7) return plural(day, "day");
  return new Date(ms).toLocaleDateString();
}

/** Stable colour for a folder path, so the same folder always gets the same colour. */
function folderColor(path: string): ColorName {
  let h = 0;
  for (let i = 0; i < path.length; i++) h = (h * 31 + path.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length];
}

/** Small yes/no dialog, used instead of window.confirm. */
class ConfirmModal extends Modal {
  constructor(app: App, private message: string, private onConfirm: () => void) {
    super(app);
  }

  onOpen() {
    this.setTitle("Vertical tabs");
    this.contentEl.createEl("p", { text: this.message });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) =>
        b.setButtonText("Close tabs").setDestructive().setCta().onClick(() => {
          this.close();
          this.onConfirm();
        })
      );
  }

  onClose() {
    this.contentEl.empty();
  }
}

class VerticalTabsView extends ItemView implements HoverParent {
  hoverPopover: HoverPopover | null = null;
  private toolbarEl!: HTMLElement;
  private listEl!: HTMLElement;
  private filterEl!: HTMLInputElement;
  private newBtnEl!: HTMLElement;
  private query = "";
  private collapsed = new Set<string>();
  /** Path of the tab being dragged in "My order" mode. */
  private dragPath: string | null = null;
  private closedCollapsed = false;
  /** Keyboard highlight in the list while typing in the filter box (-1 = none). */
  private highlight = -1;
  private rendered: WorkspaceLeaf[] = [];

  constructor(leaf: WorkspaceLeaf, private plugin: VerticalTabsPlugin) {
    super(leaf);
  }

  getViewType() {
    return VIEW_TYPE;
  }
  getDisplayText() {
    return "Vertical tabs";
  }
  getIcon() {
    return "panel-left";
  }

  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass("vt-root");

    this.toolbarEl = this.contentEl.createDiv({ cls: "vt-toolbar" });
    this.filterEl = this.toolbarEl.createEl("input", {
      cls: "vt-filter",
      attr: { type: "search", placeholder: "Filter tabs…", spellcheck: "false" },
    });
    this.filterEl.addEventListener("input", () => {
      this.query = this.filterEl.value.trim().toLowerCase();
      this.highlight = this.query ? 0 : -1;
      this.render();
    });
    this.filterEl.addEventListener("keydown", (e) => {
      const count = this.rendered.length;
      if (e.key === "ArrowDown" && count) {
        e.preventDefault();
        this.highlight = (this.highlight + 1) % count;
        this.render();
      } else if (e.key === "ArrowUp" && count) {
        e.preventDefault();
        this.highlight = this.highlight <= 0 ? count - 1 : this.highlight - 1;
        this.render();
      } else if (e.key === "Enter") {
        const target = this.rendered[Math.max(0, this.highlight)];
        if (target) this.app.workspace.setActiveLeaf(target, { focus: true });
      } else if (e.key === "Escape") {
        this.clearFilter();
      }
    });
    this.filterEl.addEventListener("blur", () => {
      if (this.highlight !== -1 && !this.query) {
        this.highlight = -1;
        this.render();
      }
    });

    this.newBtnEl = this.toolbarEl.createDiv({ cls: "vt-btn vt-new clickable-icon" });
    setIcon(this.newBtnEl, "plus");
    setTooltip(this.newBtnEl, "New tab");
    this.newBtnEl.addEventListener("click", () => this.plugin.newTab());

    this.listEl = this.contentEl.createDiv({ cls: "vt-list" });
    // Double-click on empty space below the tabs opens a new tab, like a browser tab strip.
    this.listEl.addEventListener("dblclick", (e) => {
      if (e.target === this.listEl && this.plugin.settings.doubleClickNewTab) this.plugin.newTab();
    });
    this.render();
  }

  private clearFilter() {
    if (this.filterEl) this.filterEl.value = "";
    this.query = "";
    this.highlight = -1;
    this.render();
  }

  private matches(leaf: WorkspaceLeaf): boolean {
    if (!this.query) return true;
    const file = leafFile(leaf);
    const hay = (this.plugin.titleFor(leaf) + " " + (file?.path ?? "")).toLowerCase();
    return hay.includes(this.query);
  }

  /** Sort one list of tabs according to the "Sort tabs by" setting. */
  private sortLeaves(visible: WorkspaceLeaf[]): WorkspaceLeaf[] {
    const s = this.plugin.settings;
    const byTitle = (a: WorkspaceLeaf, b: WorkspaceLeaf) =>
      this.plugin.titleFor(a).localeCompare(this.plugin.titleFor(b), undefined, { numeric: true });
    if (s.sortBy === "manual") {
      const pos = new Map(s.manualOrder.map((p, i) => [p, i] as const));
      const rank = (l: WorkspaceLeaf) => pos.get(leafFile(l)?.path ?? "") ?? Number.MAX_SAFE_INTEGER;
      visible.sort((a, b) => rank(a) - rank(b));
    } else if (s.sortBy === "title") {
      visible.sort(byTitle);
    } else if (s.sortBy === "folder") {
      visible.sort((a, b) => {
        const fa = leafFile(a)?.parent?.path ?? "";
        const fb = leafFile(b)?.parent?.path ?? "";
        return fa.localeCompare(fb, undefined, { numeric: true }) || byTitle(a, b);
      });
    } else if (s.sortBy === "modified") {
      visible.sort((a, b) => (leafFile(b)?.stat.mtime ?? 0) - (leafFile(a)?.stat.mtime ?? 0));
    } else if (s.sortBy === "recent") {
      visible.sort((a, b) => this.plugin.lastUsed(b) - this.plugin.lastUsed(a));
    }
    if (s.pinnedFirst) {
      // stable sort keeps the chosen order within pinned / unpinned
      visible.sort((a, b) => Number(isPinned(b)) - Number(isPinned(a)));
    }
    return visible;
  }

  /** Tabs split into headed groups, following the "Group by" setting. */
  private orderedGroups(): TabGroup[] {
    const s = this.plugin.settings;
    const panes = getGroups(this.app);
    const all = flatten(panes).filter((l) => this.matches(l));
    let groups: TabGroup[];

    if (s.groupBy === "pane") {
      groups = panes.map((leaves, i) => ({
        key: `pane-${i}`,
        label: `Pane ${i + 1}`,
        leaves: leaves.filter((l) => this.matches(l)),
      }));
    } else if (s.groupBy === "folder") {
      const byFolder = new Map<string, WorkspaceLeaf[]>();
      for (const l of all) {
        const folder = leafFile(l)?.parent?.path ?? "";
        const key = folder === "/" ? "" : folder;
        if (!byFolder.has(key)) byFolder.set(key, []);
        byFolder.get(key)!.push(l);
      }
      groups = [...byFolder.entries()]
        .sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b, undefined, { numeric: true })))
        .map(([folder, leaves]) => ({
          key: `folder-${folder}`,
          label: folder ? folder.split("/").pop() ?? folder : "Vault root and other",
          tooltip: folder || undefined,
          leaves,
        }));
    } else if (s.groupBy === "colour") {
      const byColor = new Map<string, WorkspaceLeaf[]>();
      for (const l of all) {
        const f = leafFile(l);
        const c = f ? this.plugin.colorFor(f) ?? "" : "";
        if (!byColor.has(c)) byColor.set(c, []);
        byColor.get(c)!.push(l);
      }
      const order: string[] = [...COLORS, ""];
      groups = order
        .filter((c) => byColor.has(c))
        .map((c) => ({
          key: `colour-${c}`,
          label: c ? COLOR_LABELS[c as ColorName] : "No colour",
          leaves: byColor.get(c)!,
        }));
    } else {
      groups = [{ key: "all", label: "", leaves: all }];
    }

    return groups
      .map((g) => ({ ...g, leaves: this.sortLeaves(g.leaves) }))
      .filter((g) => g.leaves.length > 0);
  }

  private visibleLeaves(): WorkspaceLeaf[] {
    return flatten(this.orderedGroups().map((g) => g.leaves));
  }

  /** Apply settings that only change classes / visibility. */
  private applyLayout(total: number) {
    const s = this.plugin.settings;
    const root = this.contentEl;
    root.toggleClass("vt-slim", s.density === "slim");
    root.toggleClass("vt-compact", s.density === "compact");
    root.toggleClass("vt-spacious", s.density === "spacious");
    root.toggleClass("vt-no-icons", !s.showIcons);
    root.toggleClass("vt-close-always", s.closeButton === "always");
    root.toggleClass("vt-close-never", s.closeButton === "never");
    root.toggleClass("vt-active-solid", s.activeStyle === "solid");
    root.toggleClass("vt-active-bar", s.activeStyle === "bar");
    root.toggleClass("vt-label-style-bar", s.labelStyle === "bar");
    root.toggleClass("vt-label-style-tint", s.labelStyle === "tint");
    root.toggleClass("vt-label-style-text", s.labelStyle === "text");
    root.toggleClass("vt-wrap", s.wrapTitles);
    root.toggleClass("vt-custom-accent", s.useCustomAccent);
    root.setCssProps({
      "--vt-custom-accent": s.accentColor || DEFAULT_SETTINGS.accentColor,
      "--vt-scale": String(s.textScale / 100),
      "--vt-radius": `${s.cornerRadius}px`,
    });

    this.filterEl.toggle(s.showFilter);
    this.filterEl.placeholder = s.showTabCount
      ? `Filter ${total} ${total === 1 ? "tab" : "tabs"}…`
      : "Filter tabs…";
    this.newBtnEl.toggle(s.showNewTabButton);
    this.toolbarEl.toggle(s.showFilter || s.showNewTabButton);
    if (!s.showFilter && this.query) this.clearFilter();
  }

  render() {
    if (!this.listEl) return;
    const total = flatten(getGroups(this.app)).length;
    this.applyLayout(total);
    this.listEl.empty();
    this.rendered = [];

    const active = this.app.workspace.getMostRecentLeaf();
    const groups = this.orderedGroups();
    const groupBy = this.plugin.settings.groupBy;
    // A single pane doesn't need a "Pane 1" heading; other groupings always show theirs.
    const showHeaders = groupBy !== "none" && (groupBy !== "pane" || groups.length > 1);

    groups.forEach((group) => {
      const leaves = group.leaves;
      const isCollapsed = showHeaders && this.collapsed.has(group.key) && !this.query;
      if (showHeaders) {
        const header = this.listEl.createDiv({ cls: "vt-group" });
        header.toggleClass("is-collapsed", isCollapsed);
        const chevron = header.createSpan({ cls: "vt-group-chevron" });
        setIcon(chevron, "chevron-down");
        if (groupBy === "colour" && group.key !== "colour-") {
          header.createSpan({ cls: `vt-label-dot vt-label-${group.key.slice("colour-".length)}` });
        }
        header.createSpan({ cls: "vt-group-name", text: group.label });
        if (this.plugin.settings.showTabCount) {
          header.createSpan({ cls: "vt-group-count", text: String(leaves.length) });
        }
        setTooltip(header, `${group.tooltip ? group.tooltip + " · " : ""}${isCollapsed ? "Expand" : "Collapse"}`);
        header.addEventListener("click", () => {
          if (this.collapsed.has(group.key)) this.collapsed.delete(group.key);
          else this.collapsed.add(group.key);
          this.render();
        });
      }
      if (isCollapsed) {
        // Keep the active tab visible even when its pane is collapsed.
        if (active && leaves.includes(active)) this.renderTab(active, true);
        return;
      }
      for (const leaf of leaves) this.renderTab(leaf, leaf === active);
    });

    if (groups.length === 0) {
      this.listEl.createDiv({
        cls: "vt-empty",
        text: this.query ? "No matching tabs" : "No open notes",
      });
    }
    if (this.highlight >= this.rendered.length) this.highlight = this.rendered.length - 1;

    this.renderRecentlyClosed();
  }

  private renderRecentlyClosed() {
    const s = this.plugin.settings;
    if (!s.showRecentlyClosed || this.query) return;
    const files = this.plugin.recentlyClosedFiles();
    if (!files.length) return;

    const section = this.listEl.createDiv({ cls: "vt-closed" });
    const header = section.createDiv({ cls: "vt-group vt-closed-header" });
    header.toggleClass("is-collapsed", this.closedCollapsed);
    const chevron = header.createSpan({ cls: "vt-group-chevron" });
    setIcon(chevron, "chevron-down");
    header.createSpan({ cls: "vt-group-name", text: "Recently closed" });
    const clear = header.createSpan({ cls: "vt-closed-clear clickable-icon" });
    setIcon(clear, "x");
    setTooltip(clear, "Clear list");
    clear.addEventListener("click", (e) => {
      e.stopPropagation();
      this.plugin.clearRecentlyClosed();
    });
    header.addEventListener("click", () => {
      this.closedCollapsed = !this.closedCollapsed;
      this.render();
    });
    if (this.closedCollapsed) return;

    for (const file of files) {
      const row = section.createDiv({ cls: "vt-tab vt-closed-tab" });
      setTooltip(row, `Reopen ${file.path}`, { placement: "right" });
      if (s.showIcons) setIcon(row.createSpan({ cls: "vt-icon" }), "history");
      const text = row.createDiv({ cls: "vt-text" });
      text.createDiv({ cls: "vt-title", text: s.showExtension && file.extension !== "md" ? file.name : file.basename });
      row.addEventListener("click", () => void this.plugin.reopen(file));
    }
  }

  private renderTab(leaf: WorkspaceLeaf, isActive: boolean) {
    const s = this.plugin.settings;
    const pinned = isPinned(leaf);
    const file = leafFile(leaf);
    const color = file ? this.plugin.colorFor(file) : null;

    const tab = this.listEl.createDiv({ cls: "vt-tab" });
    tab.toggleClass("is-active", isActive);
    tab.toggleClass("is-highlighted", this.rendered.length === this.highlight);
    this.rendered.push(leaf);
    tab.toggleClass("is-pinned", pinned);
    if (color) tab.addClass("has-label", `vt-label-${color}`);

    if (color) tab.createSpan({ cls: "vt-label-dot" });

    if (s.showIcons) {
      const icon = tab.createSpan({ cls: "vt-icon" });
      setIcon(icon, leaf.view.getIcon());
    }

    const text = tab.createDiv({ cls: "vt-text" });
    text.createDiv({ cls: "vt-title", text: this.plugin.titleFor(leaf) || "New tab" });
    const sub = file ? this.plugin.subtitleFor(file) : "";
    if (sub) text.createDiv({ cls: "vt-folder", text: sub });

    if (pinned) {
      const pin = tab.createSpan({ cls: "vt-action vt-pin" });
      setIcon(pin, "pin");
      setTooltip(pin, "Unpin");
      pin.addEventListener("click", (e) => {
        e.stopPropagation();
        leaf.setPinned(false);
      });
    } else if (s.closeButton !== "never") {
      const close = tab.createSpan({ cls: "vt-action vt-close" });
      setIcon(close, "x");
      setTooltip(close, "Close");
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        leaf.detach();
      });
    }

    tab.addEventListener("click", () => {
      this.app.workspace.setActiveLeaf(leaf, { focus: true });
    });
    tab.addEventListener("auxclick", (e) => {
      if (e.button === 1 && !pinned && s.middleClickClose) {
        e.preventDefault();
        leaf.detach();
      }
    });
    // Page preview on hover (uses the core "Page preview" plugin and its Mod-key setting).
    if (file) {
      tab.addEventListener("mouseover", (event) => {
        this.app.workspace.trigger("hover-link", {
          event,
          source: VIEW_TYPE,
          hoverParent: this,
          targetEl: tab,
          linktext: file.path,
        });
      });
    }
    tab.addEventListener("contextmenu", (e) => this.openMenu(e, leaf, pinned, file));

    // "My order": drag tabs to rearrange the list (doesn't change Obsidian's own tab order).
    if (file && s.sortBy === "manual" && !this.query) {
      tab.draggable = true;
      tab.addEventListener("dragstart", (e) => {
        this.dragPath = file.path;
        e.dataTransfer?.setData("text/plain", file.path);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
        tab.addClass("is-dragging");
      });
      tab.addEventListener("dragend", () => {
        this.dragPath = null;
        tab.removeClass("is-dragging");
        this.listEl.findAll(".is-drop-target").forEach((el) => el.removeClass("is-drop-target"));
      });
      tab.addEventListener("dragover", (e) => {
        if (!this.dragPath || this.dragPath === file.path) return;
        e.preventDefault();
        tab.addClass("is-drop-target");
      });
      tab.addEventListener("dragleave", () => tab.removeClass("is-drop-target"));
      tab.addEventListener("drop", (e) => {
        e.preventDefault();
        tab.removeClass("is-drop-target");
        const from = this.dragPath;
        this.dragPath = null;
        if (from && from !== file.path) void this.moveBefore(from, file.path);
      });
    }
  }

  /** Put the dragged tab just before the tab it was dropped on, and remember the order. */
  private async moveBefore(from: string, to: string) {
    const shown = this.visibleLeaves()
      .map((l) => leafFile(l)?.path)
      .filter((p): p is string => !!p);
    const order = shown.filter((p) => p !== from);
    const idx = order.indexOf(to);
    order.splice(idx < 0 ? order.length : idx, 0, from);
    // Keep remembered positions of files that aren't open right now, after the open ones.
    const rest = this.plugin.settings.manualOrder.filter((p) => !order.includes(p));
    this.plugin.settings.manualOrder = [...order, ...rest].slice(0, 500);
    await this.plugin.saveSettings();
  }

  private openColorMenu(at: { x: number; y: number }, file: TFile) {
    const current = this.plugin.settings.tabColors[file.path];
    const menu = new Menu();
    for (const c of COLORS) {
      menu.addItem((i) =>
        i
          .setTitle(COLOR_LABELS[c])
          .setIcon("circle")
          .setChecked(current === c)
          .onClick(() => void this.plugin.setTabColor(file, c))
      );
    }
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle("No colour").setIcon("circle-off").setChecked(!current)
        .onClick(() => void this.plugin.setTabColor(file, null))
    );
    menu.showAtPosition(at);
  }

  private openMenu(e: MouseEvent, leaf: WorkspaceLeaf, pinned: boolean, file: TFile | null) {
    const menu = new Menu();
    menu.addItem((i) =>
      i.setTitle(pinned ? "Unpin" : "Pin").setIcon(pinned ? "pin-off" : "pin")
        .onClick(() => leaf.setPinned(!pinned))
    );
    if (file) {
      const at = { x: e.clientX, y: e.clientY };
      menu.addItem((i) =>
        i.setTitle("Colour…").setIcon("palette").onClick(() => this.openColorMenu(at, file))
      );
      menu.addItem((i) =>
        i.setTitle("Rename tab…").setIcon("pencil").onClick(() =>
          new NicknameModal(this.app, this.plugin, file).open()
        )
      );
      if (this.plugin.settings.nicknames[file.path]) {
        menu.addItem((i) =>
          i.setTitle("Reset tab name").setIcon("rotate-ccw").onClick(() =>
            void this.plugin.setNickname(file, "")
          )
        );
      }
      menu.addSeparator();
      menu.addItem((i) =>
        i.setTitle("Duplicate tab").setIcon("copy-plus").onClick(() =>
          void this.app.workspace.getLeaf("tab").openFile(file)
        )
      );
      menu.addItem((i) =>
        i.setTitle("Open to the right").setIcon("separator-vertical").onClick(() =>
          void this.app.workspace.getLeaf("split", "vertical").openFile(file)
        )
      );
      menu.addItem((i) =>
        i.setTitle("Open in new window").setIcon("picture-in-picture-2").onClick(() =>
          void this.app.workspace.getLeaf("window").openFile(file)
        )
      );
      menu.addItem((i) =>
        i.setTitle("Reveal in file explorer").setIcon("folder-open").onClick(() => {
          this.app.workspace.setActiveLeaf(leaf, { focus: true });
          this.plugin.runCommand("file-explorer:reveal-active-file");
        })
      );
      menu.addItem((i) =>
        i.setTitle("Copy path").setIcon("copy").onClick(() =>
          void navigator.clipboard.writeText(file.path)
        )
      );
    }
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle("Close").setIcon("x").setDisabled(pinned).onClick(() => leaf.detach())
    );
    menu.addItem((i) =>
      i.setTitle("Close others").onClick(() => this.plugin.closeWhere((l) => l !== leaf))
    );
    menu.addItem((i) =>
      i.setTitle("Close tabs below").onClick(() => {
        const order = this.visibleLeaves();
        const idx = order.indexOf(leaf);
        const below = new Set(order.slice(idx + 1));
        this.plugin.closeWhere((l) => below.has(l));
      })
    );
    menu.addItem((i) => i.setTitle("Close duplicate tabs").onClick(() => this.plugin.closeDuplicates()));
    menu.addItem((i) => i.setTitle("Close all").onClick(() => this.plugin.closeAll()));
    menu.addSeparator();
    menu.addItem((i) =>
      i.setTitle("Save open tabs as a set…").setIcon("bookmark-plus").onClick(() =>
        new SaveTabSetModal(this.app, this.plugin).open()
      )
    );
    menu.addItem((i) =>
      i.setTitle("Reopen closed tab").setIcon("undo-2").onClick(() =>
        this.plugin.runCommand("workspace:undo-close-pane")
      )
    );
    menu.showAtMouseEvent(e);
  }

  /** Tabs in the order shown in the list (used by "Go to tab N"). */
  displayOrder(): WorkspaceLeaf[] {
    return this.visibleLeaves();
  }

  focusFilter() {
    if (!this.plugin.settings.showFilter) return;
    this.filterEl?.focus();
    this.filterEl?.select();
  }
}

export default class VerticalTabsPlugin extends Plugin {
  settings!: VTSettings;
  private usedAt = new WeakMap<WorkspaceLeaf, number>();
  /** Which file each open tab showed last time we looked, to spot closed tabs. */
  private openPaths = new Map<WorkspaceLeaf, string>();
  /** Paths of recently closed tabs, newest first (this session only). */
  private closedPaths: string[] = [];
  private statusEl: HTMLElement | null = null;

  /** Remember files whose tabs disappeared since the last layout change. */
  private trackClosedTabs() {
    const now = new Map<WorkspaceLeaf, string>();
    this.app.workspace.iterateRootLeaves((leaf) => {
      const f = leafFile(leaf);
      if (f) now.set(leaf, f.path);
    });
    const stillOpen = new Set(now.values());
    for (const [leaf, path] of this.openPaths) {
      if (!now.has(leaf) && !stillOpen.has(path)) {
        this.closedPaths = [path, ...this.closedPaths.filter((p) => p !== path)].slice(0, 30);
      }
    }
    // Anything open again is no longer "recently closed".
    this.closedPaths = this.closedPaths.filter((p) => !stillOpen.has(p));
    this.openPaths = now;
  }

  recentlyClosedFiles(): TFile[] {
    const out: TFile[] = [];
    for (const path of this.closedPaths) {
      const f = this.app.vault.getFileByPath(path);
      if (f) out.push(f);
      if (out.length >= this.settings.recentlyClosedCount) break;
    }
    return out;
  }

  clearRecentlyClosed() {
    this.closedPaths = [];
    this.refreshViews();
  }

  async reopen(file: TFile) {
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(file);
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  /** Close extra tabs that show the same file, keeping the active (or first) one. */
  closeDuplicates() {
    const active = this.app.workspace.getMostRecentLeaf();
    const keep = new Map<string, WorkspaceLeaf>();
    const leaves = flatten(getGroups(this.app));
    for (const leaf of leaves) {
      const f = leafFile(leaf);
      if (f && leaf === active) keep.set(f.path, leaf);
    }
    for (const leaf of leaves) {
      const f = leafFile(leaf);
      if (f && !keep.has(f.path)) keep.set(f.path, leaf);
    }
    const keepers = new Set(keep.values());
    this.closeWhere((l) => leafFile(l) !== null && !keepers.has(l));
  }

  /** Save the files open right now as a named tab set. */
  async saveTabSet(name: string) {
    const paths: string[] = [];
    for (const leaf of flatten(getGroups(this.app))) {
      const f = leafFile(leaf);
      if (f && !paths.includes(f.path)) paths.push(f.path);
    }
    this.settings.tabSets = { ...this.settings.tabSets, [name]: paths };
    await this.saveSettings();
    return paths.length;
  }

  async openTabSet(name: string) {
    const paths = this.settings.tabSets[name] ?? [];
    let first: WorkspaceLeaf | null = null;
    for (const path of paths) {
      const f = this.app.vault.getFileByPath(path);
      if (!f) continue;
      const leaf = this.app.workspace.getLeaf("tab");
      await leaf.openFile(f, { active: false });
      first = first ?? leaf;
    }
    if (first) this.app.workspace.setActiveLeaf(first, { focus: true });
  }

  async deleteTabSet(name: string) {
    const next = { ...this.settings.tabSets };
    delete next[name];
    this.settings.tabSets = next;
    await this.saveSettings();
  }

  private updateStatusBar() {
    if (!this.statusEl) return;
    const count = flatten(getGroups(this.app)).length;
    this.statusEl.setText(`${count} ${count === 1 ? "tab" : "tabs"}`);
    this.statusEl.toggle(this.settings.showStatusBar);
  }

  lastUsed(leaf: WorkspaceLeaf): number {
    return this.usedAt.get(leaf) ?? 0;
  }

  /** Title shown for a tab, following the "Tab title" setting. */
  titleFor(leaf: WorkspaceLeaf): string {
    const file = leafFile(leaf);
    if (!file) return leaf.getDisplayText();
    const s = this.settings;
    const nick = s.nicknames[file.path];
    if (nick) return nick;
    const cache = this.app.metadataCache.getFileCache(file);
    if (s.titleSource === "frontmatter") {
      const fm: unknown = cache?.frontmatter?.["title"];
      if (typeof fm === "string" && fm.trim()) return fm.trim();
    } else if (s.titleSource === "heading") {
      const h = cache?.headings?.[0]?.heading;
      if (h && h.trim()) return h.trim();
    }
    return s.showExtension && file.extension !== "md" ? file.name : file.basename;
  }

  /** Second line under the title, following the "Second line" setting. */
  subtitleFor(file: TFile): string {
    switch (this.settings.subtitle) {
      case "folder": {
        const folder = file.parent?.path;
        return folder && folder !== "/" ? folder : "";
      }
      case "path":
        return file.path;
      case "modified":
        return `Edited ${timeAgo(file.stat.mtime)}`;
      default:
        return "";
    }
  }

  /** Close the least recently used unpinned tabs when there are more than the limit. */
  enforceTabLimit() {
    const limit = this.settings.tabLimit;
    if (!limit || limit < 1) return;
    const leaves = flatten(getGroups(this.app));
    let extra = leaves.length - limit;
    if (extra <= 0) return;
    const active = this.app.workspace.getMostRecentLeaf();
    const candidates = leaves
      .filter((l) => l !== active && !isPinned(l))
      .sort((a, b) => this.lastUsed(a) - this.lastUsed(b));
    for (const leaf of candidates) {
      if (extra-- <= 0) break;
      leaf.detach();
    }
  }

  colorFor(file: TFile): ColorName | null {
    const own = this.settings.tabColors[file.path];
    if (own) return own;
    if (this.settings.colorByFolder) {
      const folder = file.parent?.path;
      if (folder && folder !== "/") return folderColor(folder);
    }
    return null;
  }

  async setTabColor(file: TFile, color: ColorName | null) {
    const next = { ...this.settings.tabColors };
    if (color) next[file.path] = color;
    else delete next[file.path];
    this.settings.tabColors = next;
    await this.saveSettings();
  }

  runCommand(id: string) {
    (this.app as unknown as { commands: { executeCommandById(id: string): boolean } })
      .commands.executeCommandById(id);
  }

  newTab() {
    const leaf = this.app.workspace.getLeaf("tab");
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE, (leaf) => new VerticalTabsView(leaf, this));
    this.registerHoverLinkSource(VIEW_TYPE, { display: "Vertical Tabs Lite", defaultMod: true });

    this.addRibbonIcon("panel-left", "Open vertical tabs", () => void this.activateView());

    this.addCommand({
      id: "open-vertical-tabs",
      name: "Open vertical tabs",
      callback: () => void this.activateView(),
    });
    this.addCommand({
      id: "filter-tabs",
      name: "Filter open tabs",
      callback: async () => {
        const view = await this.activateView();
        view?.focusFilter();
      },
    });
    this.addCommand({ id: "next-tab", name: "Go to next tab", callback: () => this.cycle(1) });
    this.addCommand({ id: "previous-tab", name: "Go to previous tab", callback: () => this.cycle(-1) });
    for (let n = 1; n <= 9; n++) {
      this.addCommand({
        id: `go-to-tab-${n}`,
        name: n === 9 ? "Go to last tab" : `Go to tab ${n}`,
        callback: () => this.goTo(n),
      });
    }
    this.addCommand({
      id: "toggle-pin",
      name: "Pin or unpin current tab",
      callback: () => {
        const leaf = this.app.workspace.getMostRecentLeaf();
        if (leaf) leaf.setPinned(!isPinned(leaf));
      },
    });
    this.addCommand({
      id: "set-tab-colour",
      name: "Set colour of current tab",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) new ColorPickerModal(this.app, this, file).open();
        return true;
      },
    });
    this.addCommand({
      id: "toggle-native-tabs",
      name: "Toggle native tab bar",
      callback: async () => {
        this.settings.hideNativeTabs = !this.settings.hideNativeTabs;
        await this.saveSettings();
      },
    });
    this.addCommand({
      id: "close-all-tabs",
      name: "Close all unpinned tabs",
      callback: () => this.closeAll(),
    });
    this.addCommand({
      id: "rename-current-tab",
      name: "Rename current tab…",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) new NicknameModal(this.app, this, file).open();
        return true;
      },
    });
    this.addCommand({
      id: "close-duplicate-tabs",
      name: "Close duplicate tabs",
      callback: () => this.closeDuplicates(),
    });
    this.addCommand({
      id: "switch-tab",
      name: "Switch to open tab…",
      callback: () => new TabSwitcherModal(this.app, this).open(),
    });
    this.addCommand({
      id: "reopen-closed-tab",
      name: "Reopen last closed tab",
      checkCallback: (checking) => {
        const file = this.recentlyClosedFiles()[0];
        if (!file) return false;
        if (!checking) void this.reopen(file);
        return true;
      },
    });
    this.addCommand({
      id: "save-tab-set",
      name: "Save open tabs as a set…",
      callback: () => new SaveTabSetModal(this.app, this).open(),
    });
    this.addCommand({
      id: "open-tab-set",
      name: "Open a saved tab set…",
      checkCallback: (checking) => {
        if (!Object.keys(this.settings.tabSets).length) return false;
        if (!checking) new TabSetPickerModal(this.app, this, "open").open();
        return true;
      },
    });
    this.addCommand({
      id: "delete-tab-set",
      name: "Delete a saved tab set…",
      checkCallback: (checking) => {
        if (!Object.keys(this.settings.tabSets).length) return false;
        if (!checking) new TabSetPickerModal(this.app, this, "delete").open();
        return true;
      },
    });

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("vt-status");
    this.statusEl.addEventListener("click", () => void this.activateView());

    // Many workspace events fire in bursts; coalesce them into one redraw.
    const refresh = debounce(() => this.refreshViews(), 50, true);
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf && leaf.getRoot() === this.app.workspace.rootSplit) {
          this.usedAt.set(leaf, Date.now());
        }
        refresh();
      })
    );
    const limit = debounce(() => this.enforceTabLimit(), 300, true);
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.trackClosedTabs();
        refresh();
        limit();
      })
    );
    this.registerEvent(
      this.app.metadataCache.on("changed", () => {
        if (this.settings.titleSource !== "name" || this.settings.subtitle === "modified") refresh();
      })
    );
    // Keep "Edited 3 minutes ago" up to date.
    this.registerInterval(
      window.setInterval(() => {
        if (this.settings.subtitle === "modified") this.refreshViews();
      }, 60_000)
    );
    this.registerEvent(this.app.workspace.on("file-open", refresh));
    this.registerEvent(
      this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
        void this.movePathData(oldPath, file.path);
        refresh();
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file: TAbstractFile) => {
        void this.movePathData(file.path, null);
        refresh();
      })
    );

    this.addSettingTab(new VTSettingTab(this.app, this));
    this.applyBodyClass();

    this.app.workspace.onLayoutReady(() => {
      const current = this.app.workspace.getMostRecentLeaf();
      if (current) this.usedAt.set(current, Date.now());
      this.trackClosedTabs();
      this.updateStatusBar();
      if (this.settings.openOnStartup) void this.activateView(false);
    });
  }

  onunload() {
    document.body.removeClass("vt-hide-native-tabs");
  }

  /** Keep a tab's colour when its file is renamed; forget it when deleted. */
  /** Keep a tab's colour, custom name and place in "My order" when its file is renamed; forget them when deleted. */
  private async movePathData(from: string, to: string | null) {
    const s = this.settings;
    let changed = false;
    const color = s.tabColors[from];
    if (color) {
      const next = { ...s.tabColors };
      delete next[from];
      if (to) next[to] = color;
      s.tabColors = next;
      changed = true;
    }
    const nick = s.nicknames[from];
    if (nick) {
      const next = { ...s.nicknames };
      delete next[from];
      if (to) next[to] = nick;
      s.nicknames = next;
      changed = true;
    }
    const i = s.manualOrder.indexOf(from);
    if (i >= 0) {
      s.manualOrder = to
        ? s.manualOrder.map((p) => (p === from ? to : p))
        : s.manualOrder.filter((p) => p !== from);
      changed = true;
    }
    if (changed) await this.saveSettings();
  }

  async setNickname(file: TFile, name: string) {
    const next = { ...this.settings.nicknames };
    const clean = name.trim();
    if (clean && clean !== file.basename) next[file.path] = clean;
    else delete next[file.path];
    this.settings.nicknames = next;
    await this.saveSettings();
  }

  refreshViews() {
    for (const l of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (l.view instanceof VerticalTabsView) l.view.render();
    }
    this.updateStatusBar();
  }

  closeWhere(pred: (leaf: WorkspaceLeaf) => boolean) {
    const toClose: WorkspaceLeaf[] = [];
    this.app.workspace.iterateRootLeaves((l) => {
      if (pred(l) && !isPinned(l)) toClose.push(l);
    });
    toClose.forEach((l) => l.detach());
  }

  closeAll() {
    const run = () => this.closeWhere(() => true);
    if (this.settings.confirmCloseAll) {
      new ConfirmModal(this.app, "Close all unpinned tabs?", run).open();
    } else {
      run();
    }
  }

  /** Tabs in the order the list shows them (falls back to Obsidian's order). */
  private orderedLeaves(): WorkspaceLeaf[] {
    const view = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0]?.view;
    return view instanceof VerticalTabsView ? view.displayOrder() : flatten(getGroups(this.app));
  }

  goTo(n: number) {
    const leaves = this.orderedLeaves();
    if (!leaves.length) return;
    const target = n === 9 ? leaves[leaves.length - 1] : leaves[n - 1];
    if (target) this.app.workspace.setActiveLeaf(target, { focus: true });
  }

  cycle(dir: 1 | -1) {
    const leaves = this.orderedLeaves();
    if (leaves.length < 2) return;
    const current = this.app.workspace.getMostRecentLeaf();
    const idx = current ? leaves.indexOf(current) : -1;
    const next = leaves[(idx + dir + leaves.length) % leaves.length];
    this.app.workspace.setActiveLeaf(next, { focus: true });
  }

  async activateView(reveal = true): Promise<VerticalTabsView | null> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      const newLeaf =
        this.settings.side === "left"
          ? workspace.getLeftLeaf(this.settings.shareSidebar)
          : workspace.getRightLeaf(this.settings.shareSidebar);
      if (!newLeaf) return null;
      leaf = newLeaf;
      await leaf.setViewState({ type: VIEW_TYPE, active: reveal });
    }
    if (reveal) await workspace.revealLeaf(leaf);
    return leaf.view instanceof VerticalTabsView ? leaf.view : null;
  }

  /** Close the pane and reopen it on the configured side. */
  async moveView() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
    await this.activateView();
  }

  applyBodyClass() {
    document.body.toggleClass("vt-hide-native-tabs", this.settings.hideNativeTabs);
  }

  async loadSettings() {
    const saved = ((await this.loadData()) ?? {}) as Partial<VTSettings> & { showFolder?: boolean };
    const { showFolder, groupByPane, ...rest } = saved as typeof saved & { groupByPane?: boolean };
    this.settings = { ...DEFAULT_SETTINGS, ...rest };
    // 0.4.0 and earlier had a "Show folder" toggle; carry it over to "Second line".
    if (rest.subtitle === undefined && showFolder === false) this.settings.subtitle = "none";
    // 0.6.1 and earlier had a "Group by pane" toggle; carry it over to "Group by".
    if (rest.groupBy === undefined && groupByPane === false) this.settings.groupBy = "none";
    this.settings.manualOrder = Array.isArray(this.settings.manualOrder)
      ? this.settings.manualOrder.filter((x): x is string => typeof x === "string")
      : [];
    const nicks: Record<string, string> = {};
    for (const [path, n] of Object.entries(this.settings.nicknames ?? {})) {
      if (typeof n === "string" && n.trim()) nicks[path] = n.trim();
    }
    this.settings.nicknames = nicks;
    this.settings.textScale = Math.min(130, Math.max(80, Number(this.settings.textScale) || 100));
    this.settings.cornerRadius = Math.min(14, Math.max(0, Number(this.settings.cornerRadius) || 0));
    this.settings.tabLimit = Math.max(0, Math.floor(Number(this.settings.tabLimit) || 0));
    this.settings.recentlyClosedCount = Math.min(15, Math.max(1, Number(this.settings.recentlyClosedCount) || 5));
    const sets: Record<string, string[]> = {};
    for (const [name, paths] of Object.entries(this.settings.tabSets ?? {})) {
      if (Array.isArray(paths)) sets[name] = paths.filter((x): x is string => typeof x === "string");
    }
    this.settings.tabSets = sets;
    // Drop any colour values this version doesn't know about.
    const colors: Record<string, ColorName> = {};
    for (const [path, c] of Object.entries(this.settings.tabColors ?? {})) {
      if (isColor(c)) colors[path] = c;
    }
    this.settings.tabColors = colors;
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.applyBodyClass();
    this.refreshViews();
    this.enforceTabLimit();
  }
}

/** Fuzzy search across open tabs ("Switch to open tab…"). */
class TabSwitcherModal extends FuzzySuggestModal<WorkspaceLeaf> {
  constructor(app: App, private plugin: VerticalTabsPlugin) {
    super(app);
    this.setPlaceholder("Switch to an open tab…");
  }
  getItems(): WorkspaceLeaf[] {
    return flatten(getGroups(this.app));
  }
  getItemText(leaf: WorkspaceLeaf): string {
    const f = leafFile(leaf);
    const title = this.plugin.titleFor(leaf);
    return f && f.path !== `${title}.md` ? `${title} — ${f.path}` : title;
  }
  onChooseItem(leaf: WorkspaceLeaf): void {
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }
}

/** Asks for a name, then saves the open tabs under it. */
class SaveTabSetModal extends Modal {
  private name = "";
  constructor(app: App, private plugin: VerticalTabsPlugin) {
    super(app);
  }
  onOpen() {
    this.setTitle("Save open tabs as a set");
    const existing = Object.keys(this.plugin.settings.tabSets);
    let input: TextComponent | null = null;
    const save = async () => {
      const name = this.name.trim();
      if (!name) return;
      await this.plugin.saveTabSet(name);
      this.close();
    };
    new Setting(this.contentEl)
      .setName("Name")
      .setDesc(existing.length ? `Using an existing name replaces that set. Saved: ${existing.join(", ")}` : "")
      .addText((t) => {
        input = t;
        t.setPlaceholder("e.g. Biology revision").onChange((v) => (this.name = v));
        t.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter") void save();
        });
      });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => b.setButtonText("Save").setCta().onClick(() => void save()));
    window.setTimeout(() => input?.inputEl.focus(), 0);
  }
  onClose() {
    this.contentEl.empty();
  }
}

/** Give a tab its own name in the list, without renaming the file. */
class NicknameModal extends Modal {
  private name: string;
  constructor(app: App, private plugin: VerticalTabsPlugin, private file: TFile) {
    super(app);
    this.name = plugin.settings.nicknames[file.path] ?? file.basename;
  }
  onOpen() {
    this.setTitle("Rename tab");
    let input: TextComponent | null = null;
    const save = async () => {
      await this.plugin.setNickname(this.file, this.name);
      this.close();
    };
    new Setting(this.contentEl)
      .setName("Name in the tab list")
      .setDesc(`Only changes how the tab is shown here. The file "${this.file.name}" keeps its name. Leave empty to use the file name.`)
      .addText((t) => {
        input = t;
        t.setValue(this.name).onChange((v) => (this.name = v));
        t.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter") void save();
        });
      });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((b) => b.setButtonText("Save").setCta().onClick(() => void save()));
    window.setTimeout(() => {
      input?.inputEl.focus();
      input?.inputEl.select();
    }, 0);
  }
  onClose() {
    this.contentEl.empty();
  }
}

/** Pick a saved tab set to open or delete. */
class TabSetPickerModal extends FuzzySuggestModal<string> {
  constructor(app: App, private plugin: VerticalTabsPlugin, private mode: "open" | "delete") {
    super(app);
    this.setPlaceholder(mode === "open" ? "Open a saved tab set…" : "Delete a saved tab set…");
  }
  getItems(): string[] {
    return Object.keys(this.plugin.settings.tabSets).sort();
  }
  getItemText(name: string): string {
    const n = this.plugin.settings.tabSets[name]?.length ?? 0;
    return `${name} (${n} ${n === 1 ? "tab" : "tabs"})`;
  }
  onChooseItem(name: string): void {
    if (this.mode === "open") void this.plugin.openTabSet(name);
    else void this.plugin.deleteTabSet(name);
  }
}

/** Quick colour picker for the "Set colour of current tab" command. */
class ColorPickerModal extends Modal {
  constructor(app: App, private plugin: VerticalTabsPlugin, private file: TFile) {
    super(app);
  }

  onOpen() {
    this.setTitle(`Colour for "${this.file.basename}"`);
    const current = this.plugin.settings.tabColors[this.file.path];
    const grid = this.contentEl.createDiv({ cls: "vt-swatches" });
    const pick = (c: ColorName | null) => {
      void this.plugin.setTabColor(this.file, c);
      this.close();
    };
    for (const c of COLORS) {
      const sw = grid.createEl("button", { cls: `vt-swatch vt-label-${c}`, attr: { "aria-label": COLOR_LABELS[c] } });
      sw.toggleClass("is-selected", current === c);
      setTooltip(sw, COLOR_LABELS[c]);
      sw.addEventListener("click", () => pick(c));
    }
    const none = grid.createEl("button", { cls: "vt-swatch vt-swatch-none", attr: { "aria-label": "No colour" } });
    setIcon(none, "circle-off");
    setTooltip(none, "No colour");
    none.toggleClass("is-selected", !current);
    none.addEventListener("click", () => pick(null));
  }

  onClose() {
    this.contentEl.empty();
  }
}

class VTSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: VerticalTabsPlugin) {
    super(app, plugin);
  }

  private isKey(key: string): key is keyof VTSettings {
    return key in DEFAULT_SETTINGS;
  }

  getControlValue(key: string): unknown {
    return this.isKey(key) ? this.plugin.settings[key] : undefined;
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    if (!this.isKey(key)) return;
    const next: VTSettings = { ...this.plugin.settings, [key]: value };
    const sideChanged =
      (key === "side" && next.side !== this.plugin.settings.side) ||
      (key === "shareSidebar" && next.shareSidebar !== this.plugin.settings.shareSidebar);
    this.plugin.settings = next;
    await this.plugin.saveSettings();
    if (sideChanged) await this.plugin.moveView();
    if (key === "useCustomAccent") this.refreshDomState();
  }

  getSettingDefinitions(): SettingDefinitionItem<keyof VTSettings>[] {
    const colorCount = Object.keys(this.plugin.settings.tabColors).length;
    return [
      {
        type: "group",
        heading: "Placement",
        items: [
          {
            name: "Sidebar",
            desc: "Which sidebar the tab list lives in.",
            control: { type: "dropdown", key: "side", options: { left: "Left", right: "Right" } },
          },
          {
            name: "Share sidebar with other panels",
            desc: "Show the tab list below the sidebar's other panels (like Notebook Navigator or the file explorer) instead of as its own sidebar tab, so you can see both at once.",
            aliases: ["split", "stack", "notebook navigator", "file explorer"],
            control: { type: "toggle", key: "shareSidebar" },
          },
          {
            name: "Open on startup",
            desc: "Open the tab list when Obsidian starts.",
            control: { type: "toggle", key: "openOnStartup" },
          },
          {
            name: "Hide native tab bar",
            desc: "Hide the horizontal tabs above your notes, so the list is the only place tabs show.",
            aliases: ["horizontal tabs", "tab strip"],
            control: { type: "toggle", key: "hideNativeTabs" },
          },
        ],
      },
      {
        type: "group",
        heading: "Appearance",
        items: [
          {
            name: "Density",
            desc: "How much space each tab takes.",
            control: {
              type: "dropdown",
              key: "density",
              options: { slim: "Slim", compact: "Compact", comfortable: "Comfortable", spacious: "Spacious" },
            },
          },
          {
            name: "Show icons",
            desc: "Show the file-type icon next to each tab.",
            control: { type: "toggle", key: "showIcons" },
          },
          {
            name: "Tab title",
            desc: "What each tab is called. Falls back to the file name when a note has no title or heading.",
            aliases: ["name", "frontmatter", "heading"],
            control: {
              type: "dropdown",
              key: "titleSource",
              options: { name: "File name", frontmatter: "Frontmatter title", heading: "First heading" },
            },
          },
          {
            name: "Second line",
            desc: "What to show under each tab's title.",
            aliases: ["subtitle", "folder", "path", "modified"],
            control: {
              type: "dropdown",
              key: "subtitle",
              options: { folder: "Folder", path: "Full path", modified: "Last edited", none: "Nothing" },
            },
          },
          {
            name: "Show file extensions",
            desc: "Show extensions like .pdf or .canvas for files that aren't notes.",
            control: { type: "toggle", key: "showExtension" },
          },
          {
            name: "Wrap long titles",
            desc: "Let long titles use more than one line instead of cutting them off.",
            control: { type: "toggle", key: "wrapTitles" },
          },
          {
            name: "Text size",
            desc: "Size of the tab text, from 80% to 130% of normal.",
            aliases: ["font", "zoom"],
            control: { type: "slider", key: "textScale", min: 80, max: 130, step: 5 },
          },
          {
            name: "Corner roundness",
            desc: "How rounded each tab's corners are, from square (0) to very round (14).",
            aliases: ["radius", "rounded"],
            control: { type: "slider", key: "cornerRadius", min: 0, max: 14, step: 1 },
          },
          {
            name: "Show filter box",
            desc: "Show the search box above the list.",
            control: { type: "toggle", key: "showFilter" },
          },
          {
            name: "Show new tab button",
            desc: "Show the + button next to the filter box.",
            control: { type: "toggle", key: "showNewTabButton" },
          },
          {
            name: "Show tab count",
            desc: "Show how many tabs are open, in the filter box and next to each pane heading.",
            control: { type: "toggle", key: "showTabCount" },
          },
          {
            name: "Close button",
            desc: "When to show the × on each tab.",
            control: {
              type: "dropdown",
              key: "closeButton",
              options: { hover: "On hover and active tab", always: "Always", never: "Never" },
            },
          },
        ],
      },
      {
        type: "group",
        heading: "Colours",
        items: [
          {
            name: "Active tab style",
            desc: "How the tab you're on stands out.",
            aliases: ["highlight", "selected"],
            control: {
              type: "dropdown",
              key: "activeStyle",
              options: { tint: "Soft tint", solid: "Solid colour", bar: "Side bar only" },
            },
          },
          {
            name: "Custom accent colour",
            desc: "Use your own colour for the active tab instead of your theme's accent colour.",
            aliases: ["color", "accent"],
            control: { type: "toggle", key: "useCustomAccent" },
          },
          {
            name: "Accent colour",
            desc: "Colour for the active tab.",
            aliases: ["color"],
            visible: () => this.plugin.settings.useCustomAccent,
            control: { type: "color", key: "accentColor", defaultValue: DEFAULT_SETTINGS.accentColor },
          },
          {
            name: "Colour label style",
            desc: "How a tab's colour shows. Right-click a tab and choose Colour… to give it one.",
            aliases: ["color", "label"],
            control: {
              type: "dropdown",
              key: "labelStyle",
              options: { dot: "Dot", bar: "Side stripe", tint: "Background tint", text: "Coloured title" },
            },
          },
          {
            name: "Colour by folder",
            desc: "Give every tab a colour based on its folder. Colours you pick yourself still win.",
            aliases: ["color", "folder"],
            control: { type: "toggle", key: "colorByFolder" },
          },
          {
            name: "Clear tab colours",
            desc: colorCount
              ? `Remove the colours you've given ${colorCount} ${colorCount === 1 ? "note" : "notes"}.`
              : "You haven't given any tabs a colour yet.",
            disabled: () => Object.keys(this.plugin.settings.tabColors).length === 0,
            action: () => {
              this.plugin.settings.tabColors = {};
              void this.plugin.saveSettings().then(() => this.update());
            },
          },
        ],
      },
      {
        type: "group",
        heading: "Order and grouping",
        items: [
          {
            name: "Sort tabs by",
            desc: "Order of tabs in the list.",
            control: {
              type: "dropdown",
              key: "sortBy",
              options: {
                obsidian: "Obsidian's tab order",
                manual: "My order (drag to rearrange)",
                title: "Title (A–Z)",
                folder: "Folder",
                recent: "Recently used",
                modified: "Last edited",
              },
            },
          },
          {
            name: "Pinned tabs first",
            desc: "Keep pinned tabs at the top.",
            control: { type: "toggle", key: "pinnedFirst" },
          },
          {
            name: "Group by",
            desc: "Put tabs under headings. Click a heading to collapse it.",
            aliases: ["group", "pane", "folder", "colour", "color", "headings"],
            control: {
              type: "dropdown",
              key: "groupBy",
              options: { pane: "Pane (when the editor is split)", folder: "Folder", colour: "Colour", none: "Nothing" },
            },
          },
          {
            name: "Forget my order",
            desc: "Clear the order you dragged tabs into for \"My order\".",
            visible: () => this.plugin.settings.sortBy === "manual",
            disabled: () => this.plugin.settings.manualOrder.length === 0,
            action: () => {
              this.plugin.settings.manualOrder = [];
              void this.plugin.saveSettings().then(() => this.update());
            },
          },
        ],
      },
      {
        type: "group",
        heading: "Extras",
        items: [
          {
            name: "Show recently closed",
            desc: "List tabs you closed this session at the bottom, so you can click to reopen them.",
            aliases: ["history", "reopen", "undo"],
            control: { type: "toggle", key: "showRecentlyClosed" },
          },
          {
            name: "How many recently closed",
            desc: "Number of recently closed tabs to show (1–15).",
            visible: () => this.plugin.settings.showRecentlyClosed,
            control: { type: "slider", key: "recentlyClosedCount", min: 1, max: 15, step: 1 },
          },
          {
            name: "Tab count in status bar",
            desc: "Show how many tabs are open in the status bar at the bottom of the window. Click it to open the list.",
            aliases: ["status bar"],
            control: { type: "toggle", key: "showStatusBar" },
          },
          {
            name: "Saved tab sets",
            desc: Object.keys(this.plugin.settings.tabSets).length
              ? `Saved: ${Object.keys(this.plugin.settings.tabSets).sort().join(", ")}. Use the commands "Open a saved tab set…" and "Delete a saved tab set…".`
              : "Save your open tabs as a named set with the command \"Save open tabs as a set…\", then reopen them later.",
            aliases: ["session", "workspace", "group"],
          },
        ],
      },
      {
        type: "group",
        heading: "Behaviour",
        items: [
          {
            name: "Middle-click closes tab",
            desc: "Close a tab by clicking it with the mouse wheel.",
            control: { type: "toggle", key: "middleClickClose" },
          },
          {
            name: "Double-click opens new tab",
            desc: "Double-click the empty space below your tabs to open a new one.",
            control: { type: "toggle", key: "doubleClickNewTab" },
          },
          {
            name: "Tab limit",
            desc: "Close the least recently used tabs once more than this many are open. Pinned tabs are never closed. 0 means no limit.",
            aliases: ["maximum", "max tabs", "auto close"],
            control: { type: "number", key: "tabLimit", min: 0, max: 100, step: 1, placeholder: "0" },
          },
          {
            name: "Confirm before closing all",
            desc: "Ask before \"Close all\" closes your tabs.",
            control: { type: "toggle", key: "confirmCloseAll" },
          },
          {
            name: "Reset to defaults",
            desc: "Restore every option except \"Hide native tab bar\" and things you've set per tab: colours, names, your order and saved tab sets.",
            action: () => {
              const { hideNativeTabs, tabColors, tabSets, nicknames, manualOrder } = this.plugin.settings;
              this.plugin.settings = { ...DEFAULT_SETTINGS, hideNativeTabs, tabColors, tabSets, nicknames, manualOrder };
              void this.plugin.saveSettings().then(() => this.update());
            },
          },
        ],
      },
    ];
  }
}
