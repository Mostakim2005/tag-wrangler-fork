import {Notice, Modal, Setting} from "obsidian";

const MAX_ENTRIES = 10;
const MAX_FILES_PER_ENTRY = 500;

export class OperationJournal {
    constructor(plugin) {
        this.plugin = plugin;
        this.entries = [];
    }

    record(entry) {
        const files = (entry.files || []).slice(0, MAX_FILES_PER_ENTRY).map(file => ({
            path: file.path,
            before: file.before,
            after: file.after,
        }));
        this.entries.unshift({
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            type: entry.type,
            summary: entry.summary,
            createdAt: Date.now(),
            files,
            query: entry.query,
            reversible: files.length > 0,
        });
        if (this.entries.length > MAX_ENTRIES) this.entries.length = MAX_ENTRIES;
    }

    lastReversible() {
        return this.entries.find(entry => entry.reversible);
    }

    async undoLast() {
        const entry = this.lastReversible();
        if (!entry) return new Notice("There is no reversible operation in this session.");
        const ok = await this.plugin.confirmAction("Undo last bulk operation?", `${entry.summary}\n\n${entry.files.length} file snapshot(s) will be restored.`);
        if (!ok) return;
        let restored = 0;
        for (const snapshot of [...entry.files].reverse()) {
            const file = this.plugin.app.vault.getAbstractFileByPath(snapshot.path);
            if (!file) continue;
            const current = await this.plugin.app.vault.read(file);
            if (current !== snapshot.after) {
                new Notice(`Undo stopped: ${snapshot.path} changed after the operation.`);
                continue;
            }
            await this.plugin.app.vault.modify(file, snapshot.before);
            restored++;
        }
        entry.reversible = false;
        new Notice(`Undo complete: ${restored} file(s) restored.`);
    }

    openHistory() {
        new JournalModal(this.plugin, this).open();
    }
}

class JournalModal extends Modal {
    constructor(plugin, journal) {
        super(plugin.app);
        this.plugin = plugin;
        this.journal = journal;
    }

    onOpen() {
        this.titleEl.setText("Tag Wrangler operation journal");
        this.render();
    }

    render() {
        this.contentEl.empty();
        if (!this.journal.entries.length) {
            this.contentEl.createEl("p", {text: "No bulk operations have been recorded in this session."});
            return;
        }
        for (const entry of this.journal.entries) {
            const row = this.contentEl.createDiv({cls: "tag-wrangler-journal-entry"});
            const date = new Date(entry.createdAt).toLocaleString();
            row.createEl("strong", {text: `${entry.type} — ${entry.summary}`});
            row.createDiv({text: `${date} · ${entry.files.length} file snapshot(s)${entry.reversible ? " · reversible" : " · already undone"}`});
            if (entry.query) row.createDiv({text: `Query: ${entry.query}`});
            if (entry.reversible) new Setting(row)
                .addButton(b => b.setButtonText("Undo").onClick(async () => {
                    await this.journal.undoEntry(entry);
                    this.render();
                }));
        }
        new Setting(this.contentEl).addButton(b => b.setButtonText("Close").onClick(() => this.close()));
    }
}

OperationJournal.prototype.undoEntry = async function(entry) {
    const ok = await this.plugin.confirmAction("Undo operation?", `${entry.summary}\n\nRestore ${entry.files.length} file snapshot(s)?`);
    if (!ok) return;
    let restored = 0;
    for (const snapshot of [...entry.files].reverse()) {
        const file = this.plugin.app.vault.getAbstractFileByPath(snapshot.path);
        if (!file) continue;
        const current = await this.plugin.app.vault.read(file);
        if (current !== snapshot.after) {
            new Notice(`Skipped ${snapshot.path}: it changed after the operation.`);
            continue;
        }
        await this.plugin.app.vault.modify(file, snapshot.before);
        restored++;
    }
    entry.reversible = false;
    new Notice(`Undo complete: ${restored} file(s) restored.`);
};
