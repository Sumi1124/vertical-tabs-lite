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

interface VTSettings {
  hideNativeTabs: boolean;
  showFolder: boolean;
  side: "left" | "right";
  openOnStartup: boolean;
}

const DEFAULT_SETTINGS: VTSettings = {
  hideNativeTabs: false,
  showFolder: true,
  side: "left",
  openOnStartup: true,
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

class VerticalTabsView extends ItemView {
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

    const toolbar = this.contentEl.createDiv({ cls: "vt-toolbar" });
    this.filterEl = toolbar.createEl("input", {
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
        this.filterEl.value = "";
        this.query = "";
        this.render();
      }
    });

    const newBtn = toolbar.createDiv({ cls: "vt-btn clickable-icon" });
    setIcon(newBtn, "plus");
    setTooltip(newBtn, "New tab");
    newBtn.addEventListener("click", () => {
      const leaf = this.app.workspace.getLeaf("tab");
      this.app.workspace.setActiveLeaf(leaf, { focus: true });
    });

    this.listEl = this.contentEl.createDiv({ cls: "vt-list" });
    this.render();
  }

  private matches(leaf: WorkspaceLeaf): boolean {
    if (!this.query) return true;
    const file = leafFile(leaf);
    const hay = (leaf.getDisplayText() + " " + (file?.path ?? "")).toLowerCase();
    return hay.includes(this.query);
  }

  private visibleLeaves(): WorkspaceLeaf[] {
    return getGroups(this.app).flat().filter((l) => this.matches(l));
  }

  render() {
    if (!this.listEl) return;
    this.listEl.empty();

    const active = this.app.workspace.getMostRecentLeaf();
    const groups = getGroups(this.app);
    const multi = groups.length > 1;
    let shown = 0;

    groups.forEach((leaves, gi) => {
      const visible = leaves.filter((l) => this.matches(l));
      if (!visible.length) return;

      // Pinned tabs first, keep Obsidian's order otherwise.
      visible.sort(
        (a, b) => Number(!!b.getViewState().pinned) - Number(!!a.getViewState().pinned)
      );

      if (multi) {
        this.listEl.createDiv({ cls: "vt-group", text: `Pane ${gi + 1}` });
      }
      for (const leaf of visible) {
        this.renderTab(leaf, leaf === active);
        shown++;
      }
    });

    if (shown === 0) {
      this.listEl.createDiv({
        cls: "vt-empty",
        text: this.query ? "No matching tabs" : "No open notes",
      });
    }
  }

  private renderTab(leaf: WorkspaceLeaf, isActive: boolean) {
    const pinned = !!leaf.getViewState().pinned;
    const file = leafFile(leaf);

    const tab = this.listEl.createDiv({ cls: "vt-tab" });
    tab.toggleClass("is-active", isActive);
    tab.toggleClass("is-pinned", pinned);
    if (file) setTooltip(tab, file.path, { placement: "right" });

    const icon = tab.createSpan({ cls: "vt-icon" });
    setIcon(icon, leaf.view.getIcon());

    const text = tab.createDiv({ cls: "vt-text" });
    text.createDiv({ cls: "vt-title", text: leaf.getDisplayText() || "New tab" });
    const folder = file?.parent?.path;
    if (this.plugin.settings.showFolder && folder && folder !== "/") {
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
    } else {
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
      if (e.button === 1 && !pinned) {
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
          // Uses the core file-explorer command; falls back silently if disabled.
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
      i.setTitle("Close all").onClick(() => this.plugin.closeWhere(() => true))
    );
    menu.showAtMouseEvent(e);
  }

  focusFilter() {
    this.filterEl?.focus();
    this.filterEl?.select();
  }
}

export default class VerticalTabsPlugin extends Plugin {
  settings!: VTSettings;

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

    // Many workspace events fire in bursts; coalesce them into one redraw.
    const refresh = debounce(() => this.refreshViews(), 50, true);
    this.registerEvent(this.app.workspace.on("layout-change", refresh));
    this.registerEvent(this.app.workspace.on("active-leaf-change", refresh));
    this.registerEvent(this.app.workspace.on("file-open", refresh));
    this.registerEvent(this.app.vault.on("rename", refresh));
    this.registerEvent(this.app.vault.on("delete", refresh));

    this.addSettingTab(new VTSettingTab(this.app, this));
    this.applyBodyClass();

    this.app.workspace.onLayoutReady(() => {
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
      if (pred(l) && !l.getViewState().pinned) toClose.push(l);
    });
    toClose.forEach((l) => l.detach());
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

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Sidebar")
      .setDesc("Which sidebar the tab list lives in.")
      .addDropdown((d) =>
        d.addOptions({ left: "Left", right: "Right" })
          .setValue(s.side)
          .onChange(async (v) => {
            s.side = v as VTSettings["side"];
            await this.plugin.saveSettings();
            await this.plugin.moveView();
          })
      );

    new Setting(containerEl)
      .setName("Show folder")
      .setDesc("Show each note's folder under its title.")
      .addToggle((t) =>
        t.setValue(s.showFolder).onChange(async (v) => {
          s.showFolder = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Hide native tab bar")
      .setDesc("Hide the horizontal tab headers in the main editor area.")
      .addToggle((t) =>
        t.setValue(s.hideNativeTabs).onChange(async (v) => {
          s.hideNativeTabs = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Open on startup")
      .setDesc("Open the vertical tabs pane when Obsidian starts.")
      .addToggle((t) =>
        t.setValue(s.openOnStartup).onChange(async (v) => {
          s.openOnStartup = v;
          await this.plugin.saveSettings();
        })
      );
  }
}
