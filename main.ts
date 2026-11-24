import {
  App,
  ItemView,
  Menu,
  Modal,
  Plugin,
  PluginSettingTab,
  Setting,
  SettingDefinitionItem,
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

/** Flatten one level of nesting (avoids Array.prototype.flat for older targets). */
function flatten<T>(lists: T[][]): T[] {
  const out: T[] = [];
  for (const list of lists) out.push(...list);
  return out;
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

function leafFile(leaf: WorkspaceLeaf): TFile | null {
  const file = (leaf.view as { file?: TFile }).file;
  return file instanceof TFile ? file : null;
}

const isPinned = (leaf: WorkspaceLeaf) => !!leaf.getViewState().pinned;

class VerticalTabsView extends ItemView {
  private toolbarEl!: HTMLElement;
  private listEl!: HTMLElement;
  private filterEl!: HTMLInputElement;
  private newBtnEl!: HTMLElement;
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
    this.newBtnEl = newBtn;
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
    if (!s.groupByPane) groups = [flatten(groups)];

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
    return flatten(this.orderedGroups());
  }

  /** Apply settings that only change classes / visibility. */
  private applyLayout() {
    const s = this.plugin.settings;
    this.contentEl.toggleClass("vt-compact", s.density === "compact");
    this.contentEl.toggleClass("vt-spacious", s.density === "spacious");
    this.contentEl.toggleClass("vt-no-icons", !s.showIcons);
    this.contentEl.toggleClass("vt-close-always", s.closeButton === "always");
    this.contentEl.toggleClass("vt-close-never", s.closeButton === "never");
    this.filterEl.toggle(s.showFilter);
    this.newBtnEl.toggle(s.showNewTabButton);
    this.toolbarEl.toggle(s.showFilter || s.showNewTabButton);
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
      if (this.settings.openOnStartup) void this.activateView(false);
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
    const run = () => this.closeWhere(() => true);
    if (this.settings.confirmCloseAll) {
      new ConfirmModal(this.app, "Close all unpinned tabs?", run).open();
    } else {
      run();
    }
  }

  cycle(dir: 1 | -1) {
    const leaves = flatten(getGroups(this.app));
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
    const saved = ((await this.loadData()) ?? {}) as Partial<VTSettings>;
    this.settings = { ...DEFAULT_SETTINGS, ...saved };
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

  private isKey(key: string): key is keyof VTSettings {
    return key in DEFAULT_SETTINGS;
  }

  getControlValue(key: string): unknown {
    return this.isKey(key) ? this.plugin.settings[key] : undefined;
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    if (!this.isKey(key)) return;
    const next = { ...this.plugin.settings, [key]: value } as VTSettings;
    const sideChanged = key === "side" && next.side !== this.plugin.settings.side;
    this.plugin.settings = next;
    await this.plugin.saveSettings();
    if (sideChanged) await this.plugin.moveView();
  }

  getSettingDefinitions(): SettingDefinitionItem<keyof VTSettings & string>[] {
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
            name: "Show folder",
            desc: "Show each note's folder under its title.",
            control: { type: "toggle", key: "showFolder" },
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
        heading: "Order and grouping",
        items: [
          {
            name: "Sort tabs by",
            desc: "Order of tabs in the list.",
            control: {
              type: "dropdown",
              key: "sortBy",
              options: { obsidian: "Obsidian's tab order", title: "Title (A–Z)", recent: "Recently used" },
            },
          },
          {
            name: "Pinned tabs first",
            desc: "Keep pinned tabs at the top.",
            control: { type: "toggle", key: "pinnedFirst" },
          },
          {
            name: "Group by pane",
            desc: "When the editor is split, show a heading for each pane.",
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
            name: "Confirm before closing all",
            desc: "Ask before \"Close all\" closes your tabs.",
            control: { type: "toggle", key: "confirmCloseAll" },
          },
          {
            name: "Reset to defaults",
            desc: "Restore every option except \"Hide native tab bar\".",
            action: () => {
              const keepHidden = this.plugin.settings.hideNativeTabs;
              this.plugin.settings = { ...DEFAULT_SETTINGS, hideNativeTabs: keepHidden };
              void this.plugin.saveSettings().then(() => this.update());
            },
          },
        ],
      },
    ];
  }
}
