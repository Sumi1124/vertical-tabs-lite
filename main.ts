import {
  App,
  ItemView,
  Menu,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
  debounce,
  setIcon,
  setTooltip,
} from "obsidian";

const VIEW_TYPE = "vertical-tabs-lite";

type SortBy = "obsidian" | "title" | "recent";
type CloseButton = "hover" | "always" | "never";
type Density = "compact" | "comfortable" | "spacious";

interface VTSettings {
  // Placement
  side: "left" | "right";
  openOnStartup: boolean;
  hideNativeTabs: boolean;
  // Appearance
  density: Density;
  showIcons: boolean;
  showFolder: boolean;
  showFilter: boolean;
  showNewTabButton: boolean;
  closeButton: CloseButton;
  // Order & grouping
  sortBy: SortBy;
  pinnedFirst: boolean;
  groupByPane: boolean;
  // Behaviour
  middleClickClose: boolean;
  confirmCloseAll: boolean;
}

const DEFAULT_SETTINGS: VTSettings = {
  side: "left",
  openOnStartup: true,
  hideNativeTabs: false,
  density: "comfortable",
  showIcons: true,
  showFolder: true,
  showFilter: true,
  showNewTabButton: true,
  closeButton: "hover",
  sortBy: "obsidian",
  pinnedFirst: true,
  groupByPane: true,
  middleClickClose: true,
  confirmCloseAll: true,
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

function leafFile(leaf: WorkspaceLeaf): TFile | null {
  const file = (leaf.view as { file?: TFile }).file;
  return file instanceof TFile ? file : null;
}

const isPinned = (leaf: WorkspaceLeaf) => !!leaf.getViewState().pinned;

class VerticalTabsView extends ItemView {
  private toolbarEl!: HTMLElement;
  private listEl!: HTMLElement;
  private filterEl!: HTMLInputElement;
  private query = "";

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

    const newBtn = this.toolbarEl.createDiv({ cls: "vt-btn vt-new clickable-icon" });
    setIcon(newBtn, "plus");
    setTooltip(newBtn, "New tab");
    newBtn.addEventListener("click", () => {
      const leaf = this.app.workspace.getLeaf("tab");
      this.app.workspace.setActiveLeaf(leaf, { focus: true });
    });

    this.listEl = this.contentEl.createDiv({ cls: "vt-list" });
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
    const hay = (leaf.getDisplayText() + " " + (file?.path ?? "")).toLowerCase();
    return hay.includes(this.query);
  }

  /** Leaves in display order, grouped (or one group when grouping is off). */
  private orderedGroups(): WorkspaceLeaf[][] {
    const s = this.plugin.settings;
    let groups = getGroups(this.app);
    if (!s.groupByPane) groups = [groups.flat()];

    return groups
      .map((leaves) => {
        const visible = leaves.filter((l) => this.matches(l));
        if (s.sortBy === "title") {
          visible.sort((a, b) =>
            a.getDisplayText().localeCompare(b.getDisplayText(), undefined, { numeric: true })
          );
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
    return this.orderedGroups().flat();
  }

  /** Apply settings that only change classes / visibility. */
  private applyLayout() {
    const s = this.plugin.settings;
    this.contentEl.toggleClass("vt-compact", s.density === "compact");
    this.contentEl.toggleClass("vt-spacious", s.density === "spacious");
    this.contentEl.toggleClass("vt-no-icons", !s.showIcons);
    this.contentEl.toggleClass("vt-close-always", s.closeButton === "always");
    this.contentEl.toggleClass("vt-close-never", s.closeButton === "never");
    this.filterEl.toggleClass("vt-hidden", !s.showFilter);
    this.toolbarEl.querySelector(".vt-new")?.toggleClass("vt-hidden", !s.showNewTabButton);
    this.toolbarEl.toggleClass("vt-hidden", !s.showFilter && !s.showNewTabButton);
    if (!s.showFilter && this.query) this.clearFilter();
  }

  render() {
    if (!this.listEl) return;
    this.applyLayout();
    this.listEl.empty();

    const active = this.app.workspace.getMostRecentLeaf();
    const groups = this.orderedGroups();
    const showHeaders = this.plugin.settings.groupByPane && groups.length > 1;

    groups.forEach((leaves, gi) => {
      if (showHeaders) {
        this.listEl.createDiv({ cls: "vt-group", text: `Pane ${gi + 1}` });
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

    const tab = this.listEl.createDiv({ cls: "vt-tab" });
    tab.toggleClass("is-active", isActive);
    tab.toggleClass("is-pinned", pinned);
    if (file) setTooltip(tab, file.path, { placement: "right" });

    if (s.showIcons) {
      const icon = tab.createSpan({ cls: "vt-icon" });
      setIcon(icon, leaf.view.getIcon());
    }

    const text = tab.createDiv({ cls: "vt-text" });
    text.createDiv({ cls: "vt-title", text: leaf.getDisplayText() || "New tab" });
    const folder = file?.parent?.path;
    if (s.showFolder && folder && folder !== "/") {
      text.createDiv({ cls: "vt-folder", text: folder });
    }

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
    tab.addEventListener("contextmenu", (e) => this.openMenu(e, leaf, pinned, file));
  }

  private openMenu(e: MouseEvent, leaf: WorkspaceLeaf, pinned: boolean, file: TFile | null) {
    const menu = new Menu();
    menu.addItem((i) =>
      i.setTitle(pinned ? "Unpin" : "Pin").setIcon(pinned ? "pin-off" : "pin")
        .onClick(() => leaf.setPinned(!pinned))
    );
    if (file) {
      menu.addItem((i) =>
        i.setTitle("Open to the right").setIcon("separator-vertical").onClick(() =>
          this.app.workspace.getLeaf("split", "vertical").openFile(file)
        )
      );
      menu.addItem((i) =>
        i.setTitle("Reveal in file explorer").setIcon("folder-open").onClick(() => {
          this.app.workspace.setActiveLeaf(leaf, { focus: true });
          (this.app as unknown as { commands: { executeCommandById(id: string): void } })
            .commands.executeCommandById("file-explorer:reveal-active-file");
        })
      );
      menu.addItem((i) =>
        i.setTitle("Copy path").setIcon("copy").onClick(() =>
          navigator.clipboard.writeText(file.path)
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
      i.setTitle("Close all").onClick(() => this.plugin.closeAll())
    );
    menu.showAtMouseEvent(e);
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

  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE, (leaf) => new VerticalTabsView(leaf, this));

    this.addRibbonIcon("panel-left", "Open vertical tabs", () => this.activateView());

    this.addCommand({
      id: "open-vertical-tabs",
      name: "Open vertical tabs",
      callback: () => this.activateView(),
    });
    this.addCommand({
      id: "filter-tabs",
      name: "Filter open tabs",
      callback: async () => {
        const view = await this.activateView();
        view?.focusFilter();
      },
    });
    this.addCommand({
      id: "next-tab",
      name: "Go to next tab",
      callback: () => this.cycle(1),
    });
    this.addCommand({
      id: "previous-tab",
      name: "Go to previous tab",
      callback: () => this.cycle(-1),
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
    this.registerEvent(this.app.workspace.on("layout-change", refresh));
    this.registerEvent(this.app.workspace.on("file-open", refresh));
    this.registerEvent(this.app.vault.on("rename", refresh));
    this.registerEvent(this.app.vault.on("delete", refresh));

    this.addSettingTab(new VTSettingTab(this.app, this));
    this.applyBodyClass();

    this.app.workspace.onLayoutReady(() => {
      const current = this.app.workspace.getMostRecentLeaf();
      if (current) this.usedAt.set(current, Date.now());
      if (this.settings.openOnStartup) this.activateView(false);
    });
  }

  onunload() {
    document.body.removeClass("vt-hide-native-tabs");
  }

  refreshViews() {
    for (const l of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      (l.view as VerticalTabsView).render();
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
    if (this.settings.confirmCloseAll && !window.confirm("Close all unpinned tabs?")) return;
    this.closeWhere(() => true);
  }

  cycle(dir: 1 | -1) {
    const leaves = getGroups(this.app).flat();
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
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.applyBodyClass();
    this.refreshViews();
  }
}

class VTSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: VerticalTabsPlugin) {
    super(app, plugin);
  }

  private toggle(el: HTMLElement, name: string, desc: string, key: keyof VTSettings) {
    const s = this.plugin.settings as unknown as Record<string, unknown>;
    new Setting(el).setName(name).setDesc(desc).addToggle((t) =>
      t.setValue(s[key] as boolean).onChange(async (v) => {
        s[key] = v;
        await this.plugin.saveSettings();
      })
    );
  }

  private dropdown(
    el: HTMLElement,
    name: string,
    desc: string,
    key: keyof VTSettings,
    options: Record<string, string>,
    after?: () => Promise<void>
  ) {
    const s = this.plugin.settings as unknown as Record<string, unknown>;
    new Setting(el).setName(name).setDesc(desc).addDropdown((d) =>
      d.addOptions(options).setValue(s[key] as string).onChange(async (v) => {
        s[key] = v;
        await this.plugin.saveSettings();
        if (after) await after();
      })
    );
  }

  display() {
    const { containerEl: el } = this;
    el.empty();

    new Setting(el).setName("Placement").setHeading();
    this.dropdown(el, "Sidebar", "Which sidebar the tab list lives in.", "side",
      { left: "Left", right: "Right" }, () => this.plugin.moveView());
    this.toggle(el, "Open on startup", "Open the tab list when Obsidian starts.", "openOnStartup");
    this.toggle(el, "Hide native tab bar",
      "Hide the horizontal tabs above your notes, so the list is the only place tabs show.",
      "hideNativeTabs");

    new Setting(el).setName("Appearance").setHeading();
    this.dropdown(el, "Density", "How much space each tab takes.", "density",
      { compact: "Compact", comfortable: "Comfortable", spacious: "Spacious" });
    this.toggle(el, "Show icons", "Show the file-type icon next to each tab.", "showIcons");
    this.toggle(el, "Show folder", "Show each note's folder under its title.", "showFolder");
    this.toggle(el, "Show filter box", "Show the search box above the list.", "showFilter");
    this.toggle(el, "Show new tab button", "Show the + button next to the filter box.", "showNewTabButton");
    this.dropdown(el, "Close button", "When to show the × on each tab.", "closeButton",
      { hover: "On hover and active tab", always: "Always", never: "Never" });

    new Setting(el).setName("Order and grouping").setHeading();
    this.dropdown(el, "Sort tabs by", "Order of tabs in the list.", "sortBy",
      { obsidian: "Obsidian's tab order", title: "Title (A–Z)", recent: "Recently used" });
    this.toggle(el, "Pinned tabs first", "Keep pinned tabs at the top.", "pinnedFirst");
    this.toggle(el, "Group by pane",
      "When the editor is split, show a heading for each pane.", "groupByPane");

    new Setting(el).setName("Behaviour").setHeading();
    this.toggle(el, "Middle-click closes tab", "Close a tab by clicking it with the mouse wheel.", "middleClickClose");
    this.toggle(el, "Confirm before closing all", "Ask before \"Close all\" closes your tabs.", "confirmCloseAll");

    new Setting(el).addButton((b) =>
      b.setButtonText("Reset to defaults").setWarning().onClick(async () => {
        const keepHidden = this.plugin.settings.hideNativeTabs;
        this.plugin.settings = { ...DEFAULT_SETTINGS, hideNativeTabs: keepHidden };
        await this.plugin.saveSettings();
        this.display();
      })
    );
  }
}
