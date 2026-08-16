import { ButtonComponent, Modal, Notice, Setting } from "obsidian";
import { buildDeletePlan, buildRenamePlan, commitPlan, transformTag } from "./bulk-tags";
import { Tag } from "./Tag";

export class TagSelectionManager {
    constructor(plugin) {
        this.plugin = plugin;
        this.selected = new Set();
        this.observer = null;
        this.currentContainer = null;
        this.toolbar = null;
        this.selectionClass = "tag-wrangler-selected";
    }

    start() {
        this.plugin.registerDomEvent(document, "click", (event) => {
            const target = event.target?.closest?.(".tag-wrangler-select-toggle");
            if (!target) return;
            const row = target.closest(".tag-pane-tag");
            const tag = row && this.tagFromElement(row);
            if (!tag) return;
            event.preventDefault();
            event.stopPropagation();
            this.toggle(tag);
        }, true);

        this.plugin.registerDomEvent(document, "keydown", (event) => {
            if (event.key !== " " || event.target?.closest?.(".tag-wrangler-select-toggle") == null) return;
            const row = event.target.closest(".tag-pane-tag");
            const tag = row && this.tagFromElement(row);
            if (!tag) return;
            event.preventDefault();
            this.toggle(tag);
        }, true);

        this.plugin.registerEvent(this.plugin.app.workspace.on("layout-change", () => this.ensureUI()));
        this.plugin.registerEvent(this.plugin.app.workspace.on("active-leaf-change", () => this.ensureUI()));
        this.plugin.registerInterval(window.setInterval(() => this.ensureUI(), 1000));
        this.ensureUI();
    }

    allTags() {
        return Object.keys(this.plugin.app.metadataCache.getTags() || {})
            .map(tag => Tag.toName(tag))
            .filter(Boolean);
    }

    tagFromElement(el) {
        const text = el.querySelector(".tag-pane-tag-text, tag-pane-tag-text, .tree-item-inner-text")?.textContent?.trim();
        return text ? Tag.toName(text) : null;
    }

    getSelected() {
        const known = new Map(this.allTags().map(tag => [Tag.canonical(tag), tag]));
        return [...this.selected].map(key => known.get(key) || key).filter(Boolean);
    }

    toggle(tag) {
        const key = Tag.canonical(tag);
        if (this.selected.has(key)) this.selected.delete(key);
        else this.selected.add(key);
        this.refresh();
    }

    selectAll() {
        this.selected = new Set(this.allTags().map(Tag.canonical));
        this.refresh();
    }

    selectBranch(tag) {
        const root = Tag.canonical(tag);
        for (const candidate of this.allTags()) {
            const key = Tag.canonical(candidate);
            if (key === root || key.startsWith(root + "/")) this.selected.add(key);
        }
        this.refresh();
    }


    selectNone() {
        this.selected.clear();
        this.refresh();
    }

    invert() {
        const next = new Set();
        for (const tag of this.allTags()) {
            const key = Tag.canonical(tag);
            if (!this.selected.has(key)) next.add(key);
        }
        this.selected = next;
        this.refresh();
    }

    async searchSelected() {
        const tags = this.getSelected();
        if (!tags.length) return new Notice("Select at least one tag first.");
        const query = tags.map(tag => `tag:#${tag}`).join(" ");
        new BulkReviewModal(this.plugin, {
            type: "search",
            title: "Review tag search",
            summary: `${tags.length} selected tags`,
            query,
            files: [],
            onCommit: async () => {
                const search = this.plugin.app.internalPlugins.getPluginById("global-search")?.instance;
                if (!search) return new Notice("Obsidian Global Search is unavailable.");
                search.openGlobalSearch(query);
                this.plugin.operationJournal.record({type: "search", summary: `${tags.length} selected tags`, query, files: []});
            }
        }).open();
    }

    async renameSelected() {
        const tags = this.getSelected();
        if (!tags.length) return new Notice("Select at least one tag first.");
        new BulkRenameModal(this.plugin, tags, async (options) => {
            const plan = await buildRenamePlan(this.plugin.app, tags, options);
            new BulkReviewModal(this.plugin, {
                type: "rename",
                title: "Review bulk rename",
                summary: `${tags.length} selected tags`,
                files: plan.files,
                changes: tags.map(tag => ({before: tag, after: transformTag(tag, options)})),
                onCommit: async () => {
                    await commitPlan(this.plugin.app, plan, this.plugin.operationJournal, `Renamed ${tags.length} selected tags`);
                    this.clearMissing();
                    this.refresh();
                }
            }).open();
        }).open();
    }

    async deleteSelected() {
        const tags = this.getSelected();
        if (!tags.length) return new Notice("Select at least one tag first.");
        const plan = await buildDeletePlan(this.plugin.app, tags);
        new BulkReviewModal(this.plugin, {
            type: "delete",
            title: "Review bulk deletion",
            summary: `${tags.length} selected tags`,
            files: plan.files,
            changes: tags.map(tag => ({before: tag, after: "removed"})),
            onCommit: async () => {
                await commitPlan(this.plugin.app, plan, this.plugin.operationJournal, `Deleted ${tags.length} selected tags`);
                this.selectNone();
            }
        }).open();
    }

    clearMissing() {
        const known = new Set(this.allTags().map(Tag.canonical));
        for (const key of this.selected) if (!known.has(key)) this.selected.delete(key);
    }

    ensureUI() {
        const leaf = this.plugin.app.workspace.getLeavesOfType("tag")[0];
        const container = leaf?.containerEl?.querySelector?.(".tag-container");
        if (!container) return;
        if (container !== this.currentContainer) {
            this.currentContainer = container;
            this.toolbar?.remove();
            this.toolbar = this.createToolbar(container);
            this.observer?.disconnect();
            this.observer = new MutationObserver(() => this.refreshRows());
            this.observer.observe(container, {childList: true, subtree: true});
            this.plugin.register(() => this.observer?.disconnect());
        }
        this.refreshRows();
    }

    createToolbar(container) {
        const toolbar = document.createDiv({cls: "tag-wrangler-toolbar"});
        const actions = toolbar.createDiv({cls: "tag-wrangler-toolbar-actions"});
        this.addButton(actions, "Select all", () => this.selectAll());
        this.addButton(actions, "None", () => this.selectNone());
        this.addButton(actions, "Invert", () => this.invert());
        this.addButton(actions, "Rename", () => this.renameSelected());
        this.addButton(actions, "Delete", () => this.deleteSelected(), "mod-warning");
        this.addButton(actions, "Search selected", () => this.searchSelected());
        this.addButton(actions, "Undo last", () => this.plugin.operationJournal.undoLast());
        this.addButton(actions, "Journal", () => this.plugin.operationJournal.openHistory());
        const count = toolbar.createSpan({cls: "tag-wrangler-selection-count"});
        toolbar._countEl = count;
        container.parentElement?.insertBefore(toolbar, container);
        return toolbar;
    }

    addButton(parent, text, callback, cls) {
        const button = new ButtonComponent(parent);
        button.setButtonText(text).onClick(callback);
        if (cls) button.buttonEl.addClass(cls);
        button.buttonEl.addClass("tag-wrangler-toolbar-button");
        return button;
    }

    refreshRows() {
        const rows = this.currentContainer?.querySelectorAll?.(".tag-pane-tag") || [];
        for (const row of rows) {
            const tag = this.tagFromElement(row);
            if (!tag) continue;
            const key = Tag.canonical(tag);
            row.classList.toggle(this.selectionClass, this.selected.has(key));
            let toggle = row.querySelector(".tag-wrangler-select-toggle");
            if (!toggle) {
                toggle = document.createElement("button");
                toggle.className = "tag-wrangler-select-toggle";
                toggle.type = "button";
                toggle.setAttribute("aria-label", `Select ${tag}`);
                toggle.setAttribute("title", `Select ${tag}`);
                const host = row.querySelector(".tree-item-inner") || row;
                host.insertBefore(toggle, host.firstChild);
            }
            const selected = this.selected.has(key);
            if (toggle.getAttribute("aria-pressed") !== String(selected)) toggle.setAttribute("aria-pressed", String(selected));
            const mark = selected ? "✓" : "";
            if (toggle.textContent !== mark) toggle.textContent = mark;
        }
        this.toolbar?._countEl && (this.toolbar._countEl.textContent = `${this.selected.size} selected`);
    }

    refresh() {
        this.refreshRows();
    }
}

class BulkRenameModal extends Modal {
    constructor(plugin, tags, onApply) {
        super(plugin.app);
        this.tags = tags;
        this.onApply = onApply;
    }

    onOpen() {
        this.titleEl.setText(`Rename ${this.tags.length} selected tags`);
        this.contentEl.empty();
        this.contentEl.createEl("p", {text: "Apply the same transformation to every selected tag. Sub-tags keep their hierarchy."});
        this.find = "";
        this.replace = "";
        this.prefix = "";
        this.suffix = "";
        new Setting(this.contentEl).setName("Find").setDesc("Text to replace; leave empty to skip replacement.").addText(c => c.onChange(v => this.find = v));
        new Setting(this.contentEl).setName("Replace with").addText(c => c.onChange(v => this.replace = v));
        new Setting(this.contentEl).setName("Prefix").addText(c => c.onChange(v => this.prefix = v));
        new Setting(this.contentEl).setName("Suffix").addText(c => c.onChange(v => this.suffix = v));
        const preview = this.contentEl.createDiv({cls: "tag-wrangler-bulk-preview"});
        const updatePreview = () => {
            preview.empty();
            preview.createEl("strong", {text: "Preview"});
            for (const tag of this.tags.slice(0, 12)) {
                const next = transform(tag, this.find, this.replace, this.prefix, this.suffix);
                preview.createDiv({text: `#${tag} → #${next}`});
            }
            if (this.tags.length > 12) preview.createDiv({text: `…and ${this.tags.length - 12} more`});
        };
        this.contentEl.querySelectorAll("input").forEach(input => input.addEventListener("input", updatePreview));
        updatePreview();
        new Setting(this.contentEl)
            .addButton(b => b.setButtonText("Cancel").onClick(() => this.close()))
            .addButton(b => b.setButtonText("Apply").setCta().onClick(async () => {
                const next = this.tags.map(tag => transform(tag, this.find, this.replace, this.prefix, this.suffix));
                const invalid = next.find(name => !name || !Tag.isTag(Tag.toTag(name)));
                if (invalid) return new Notice(`Invalid resulting tag: ${invalid}`);
                if (next.some((name, i) => Tag.canonical(name) === Tag.canonical(this.tags[i]))) {
                    // No-op entries are fine; the service skips them.
                }
                this.close();
                await this.onApply({find: this.find, replace: this.replace, prefix: this.prefix, suffix: this.suffix});
            }));
    }

    onClose() { this.contentEl.empty(); }
}

function transform(tag, find, replace, prefix, suffix) {
    let result = tag;
    if (find) result = result.split(find).join(replace);
    return prefix + result + suffix;
}


class BulkReviewModal extends Modal {
    constructor(plugin, plan) {
        super(plugin.app);
        this.plugin = plugin;
        this.plan = plan;
    }

    onOpen() {
        this.titleEl.setText(this.plan.title);
        this.contentEl.empty();
        this.contentEl.createEl("p", {text: "Review the proposed operation. Nothing has been changed yet."});
        this.contentEl.createDiv({cls: "tag-wrangler-review-summary", text: this.plan.summary});
        if (this.plan.query) {
            this.contentEl.createEl("code", {text: this.plan.query});
            this.contentEl.createEl("p", {text: "Search is non-destructive; Confirm opens the query after this review."});
        }
        if (this.plan.changes?.length) {
            const details = this.contentEl.createEl("details", {open: true});
            details.createEl("summary", {text: `${this.plan.changes.length} tag change(s)`});
            for (const change of this.plan.changes.slice(0, 100)) details.createDiv({text: `#${change.before} → ${change.after === "removed" ? "removed" : "#" + change.after}`});
            if (this.plan.changes.length > 100) details.createDiv({text: `…and ${this.plan.changes.length - 100} more`});
        }
        const files = this.plan.files || [];
        const details = this.contentEl.createEl("details");
        details.createEl("summary", {text: `${files.length} file(s) will change`});
        for (const file of files.slice(0, 100)) {
            const row = details.createDiv({cls: "tag-wrangler-review-file"});
            row.createEl("strong", {text: file.path});
            row.createDiv({text: `${file.before.length} → ${file.after.length} characters`});
        }
        if (files.length > 100) details.createDiv({text: `…and ${files.length - 100} more`});
        if (!files.length && this.plan.type !== "search") this.contentEl.createDiv({cls: "tag-wrangler-review-empty", text: "No files would change."});
        new Setting(this.contentEl)
            .addButton(b => b.setButtonText("Cancel").onClick(() => this.close()))
            .addButton(b => b.setButtonText(this.plan.type === "search" ? "Open search" : "Confirm & apply").setCta().onClick(async () => {
                this.close();
                await this.plan.onCommit();
            }));
    }

    onClose() { this.contentEl.empty(); }
}
