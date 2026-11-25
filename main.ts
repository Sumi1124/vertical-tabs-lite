import {
  App,
  HoverParent,
  HoverPopover,
  ItemView,
  Menu,
  Modal,
  Plugin,
  PluginSettingTab,
  Setting,
  SettingDefinitionItem,
  TAbstractFile,
  TFile,
  WorkspaceLeaf,
  debounce,
  moment,
  setIcon,
  setTooltip,
} from "obsidian";

const VIEW_TYPE = "vertical-tabs-lite";

type SortBy = "obsidian" | "title" | "recent" | "folder" | "modified";
type TitleSource = "name" | "frontmatter" | "heading";
type Subtitle = "folder" | "path" | "modified" | "none";
type CloseButton = "hover" | "always" | "never";
type Density = "compact" | "comfortable" | "spacious";
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
  groupByPane: boolean;
  // Behaviour
  middleClickClose: boolean;
  doubleClickNewTab: boolean;
  confirmCloseAll: boolean;
  tabLimit: number;
}

const DEFAULT_SETTINGS: VTSettings = {
  side: "left",
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
  groupByPane: true,
  middleClickClose: true,
  doubleClickNewTab: true,
  confirmCloseAll: true,
  tabLimit: 0,
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
  private collapsed = new Set<number>();

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
      this.render();
    });
    this.filterEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const first = this.visibleLeaves()[0];
        if (first) this.app.workspace.setActiveLeaf(first, { focus: true });
      } else if (e.key === "Escape") {
        this.clearFilter();
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
    this.render();
  }

  private matches(leaf: WorkspaceLeaf): boolean {
    if (!this.query) return true;
    const file = leafFile(leaf);
    const hay = (this.plugin.titleFor(leaf) + " " + (file?.path ?? "")).toLowerCase();
    return hay.includes(this.query);
  }

  /** Leaves in display order, grouped (or one group when grouping is off). */
  private orderedGroups(): WorkspaceLeaf[][] {
    const s = this.plugin.settings;
    let groups = getGroups(this.app);
    if (!s.groupByPane) groups = [flatten(groups)];

    return groups
      .map((leaves) => {
        const visible = leaves.filter((l) => this.matches(l));
        const byTitle = (a: WorkspaceLeaf, b: WorkspaceLeaf) =>
          this.plugin.titleFor(a).localeCompare(this.plugin.titleFor(b), undefined, { numeric: true });
        if (s.sortBy === "title") {
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
      })
      .filter((g) => g.length > 0);
  }

  private visibleLeaves(): WorkspaceLeaf[] {
    return flatten(this.orderedGroups());
  }

  /** Apply settings that only change classes / visibility. */
  private applyLayout(total: number) {
    const s = this.plugin.settings;
    const root = this.contentEl;
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

    const active = this.app.workspace.getMostRecentLeaf();
    const groups = this.orderedGroups();
    const showHeaders = this.plugin.settings.groupByPane && groups.length > 1;

    groups.forEach((leaves, gi) => {
      const isCollapsed = showHeaders && this.collapsed.has(gi) && !this.query;
      if (showHeaders) {
        const header = this.listEl.createDiv({ cls: "vt-group" });
        header.toggleClass("is-collapsed", isCollapsed);
        const chevron = header.createSpan({ cls: "vt-group-chevron" });
        setIcon(chevron, "chevron-down");
        header.createSpan({ cls: "vt-group-name", text: `Pane ${gi + 1}` });
        if (this.plugin.settings.showTabCount) {
          header.createSpan({ cls: "vt-group-count", text: String(leaves.length) });
        }
        setTooltip(header, isCollapsed ? "Expand" : "Collapse");
        header.addEventListener("click", () => {
          if (this.collapsed.has(gi)) this.collapsed.delete(gi);
          else this.collapsed.add(gi);
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
  }

  private renderTab(leaf: WorkspaceLeaf, isActive: boolean) {
    const s = this.plugin.settings;
    const pinned = isPinned(leaf);
    const file = leafFile(leaf);
    const color = file ? this.plugin.colorFor(file) : null;

    const tab = this.listEl.createDiv({ cls: "vt-tab" });
    tab.toggleClass("is-active", isActive);
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
    menu.addItem((i) => i.setTitle("Close all").onClick(() => this.plugin.closeAll()));
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

  lastUsed(leaf: WorkspaceLeaf): number {
    return this.usedAt.get(leaf) ?? 0;
  }

  /** Title shown for a tab, following the "Tab title" setting. */
  titleFor(leaf: WorkspaceLeaf): string {
    const file = leafFile(leaf);
    if (!file) return leaf.getDisplayText();
    const s = this.settings;
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
        return `Edited ${moment(file.stat.mtime).fromNow()}`;
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
        void this.moveColor(oldPath, file.path);
        refresh();
      })
    );
    this.registerEvent(
      this.app.vault.on("delete", (file: TAbstractFile) => {
        void this.moveColor(file.path, null);
        refresh();
      })
    );

    this.addSettingTab(new VTSettingTab(this.app, this));
    this.applyBodyClass();

    this.app.workspace.onLayoutReady(() => {
      const current = this.app.workspace.getMostRecentLeaf();
      if (current) this.usedAt.set(current, Date.now());
      if (this.settings.openOnStartup) void this.activateView(false);
    });
  }

  onunload() {
    document.body.removeClass("vt-hide-native-tabs");
  }

  /** Keep a tab's colour when its file is renamed; forget it when deleted. */
  private async moveColor(from: string, to: string | null) {
    const color = this.settings.tabColors[from];
    if (!color) return;
    const next = { ...this.settings.tabColors };
    delete next[from];
    if (to) next[to] = color;
    this.settings.tabColors = next;
    await this.saveSettings();
  }

  refreshViews() {
    for (const l of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (l.view instanceof VerticalTabsView) l.view.render();
    }
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
          ? workspace.getLeftLeaf(false)
          : workspace.getRightLeaf(false);
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
    const { showFolder, ...rest } = saved;
    this.settings = { ...DEFAULT_SETTINGS, ...rest };
    // 0.4.0 and earlier had a "Show folder" toggle; carry it over to "Second line".
    if (rest.subtitle === undefined && showFolder === false) this.settings.subtitle = "none";
    this.settings.textScale = Math.min(130, Math.max(80, Number(this.settings.textScale) || 100));
    this.settings.cornerRadius = Math.min(14, Math.max(0, Number(this.settings.cornerRadius) || 0));
    this.settings.tabLimit = Math.max(0, Math.floor(Number(this.settings.tabLimit) || 0));
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
    const sideChanged = key === "side" && next.side !== this.plugin.settings.side;
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
              options: { compact: "Compact", comfortable: "Comfortable", spacious: "Spacious" },
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
            name: "Group by pane",
            desc: "When the editor is split, show a heading for each pane. Click a heading to collapse it.",
            control: { type: "toggle", key: "groupByPane" },
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
            desc: "Restore every option except \"Hide native tab bar\" and your tab colours.",
            action: () => {
              const { hideNativeTabs, tabColors } = this.plugin.settings;
              this.plugin.settings = { ...DEFAULT_SETTINGS, hideNativeTabs, tabColors };
              void this.plugin.saveSettings().then(() => this.update());
            },
          },
        ],
      },
    ];
  }
}
