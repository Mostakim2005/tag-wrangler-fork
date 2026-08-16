import { Notice } from "obsidian";
import { CST, parseDocument } from "yaml";
import { Replacement, Tag } from "./Tag";

export class File {
    static renderRenamed(text, replacements, positions = []) {
        let result = text;
        const sorted = [...positions].sort((a, b) => b.position.start.offset - a.position.start.offset);
        for (const {position: {start, end}, tag} of sorted) {
            const found = replacements.find(r => r.fromTag.matches(tag));
            if (!found) continue;
            if (result.slice(start.offset, end.offset) !== tag) return text;
            result = found.inString(result, start.offset);
        }
        const file = new File(null, "", [], true);
        return file.replaceInFrontMatter(result, replacements, true);
    }

    static renderRemoved(text, tags, positions, hasFrontMatter) {
        let result = text;
        const sorted = [...(positions || [])].filter(({tag}) => tags.some(t => t.matches(tag)))
            .sort((a, b) => b.position.start.offset - a.position.start.offset);
        for (const {position: {start, end}, tag} of sorted) {
            if (result.slice(start.offset, end.offset) !== tag) return text;
            result = result.slice(0, start.offset) + result.slice(end.offset);
        }
        if (hasFrontMatter) result = removeFromFrontMatterText(result, tags);
        return result;
    }

    constructor(app, filename, tagPositions, hasFrontMatter) {
        this.app = app;
        this.filename = filename;
        this.basename = filename.split("/").pop();
        this.tagPositions = tagPositions || [];
        this.hasFrontMatter = !!hasFrontMatter;
    }

    /** @param {Replacement} replace */
    async renamed(replace) {
        const file = this.app.vault.getAbstractFileByPath(this.filename);
        if (!file) return false;
        const original = await this.app.vault.read(file);
        let text = original;
        const replacements = Array.isArray(replace) ? replace : [replace];
        const positions = [...this.tagPositions].sort((a, b) => b.position.start.offset - a.position.start.offset);

        for (const {position: {start, end}, tag} of positions) {
            const found = replacements.find(r => r.fromTag.matches(tag));
            if (!found) continue;
            if (text.slice(start.offset, end.offset) !== tag) {
                const msg = `File ${this.filename} has changed; skipping`;
                new Notice(msg);
                console.error(msg);
                return false;
            }
            text = found.inString(text, start.offset);
        }

        if (this.hasFrontMatter) text = this.replaceInFrontMatter(text, replacements);
        if (text !== original) {
            await this.app.vault.modify(file, text);
            return true;
        }
        return false;
    }

    async removed(tag) {
        const tagsToRemove = Array.isArray(tag) ? tag : [tag];
        const file = this.app.vault.getAbstractFileByPath(this.filename);
        if (!file) return false;
        const original = await this.app.vault.read(file);
        let text = original;
        const positions = [...this.tagPositions]
            .filter(({tag: found}) => tagsToRemove.some(t => Tag.canonical(found) === t.canonical))
            .sort((a, b) => b.position.start.offset - a.position.start.offset);

        for (const {position: {start, end}, tag: found} of positions) {
            if (text.slice(start.offset, end.offset) !== found) {
                const msg = `File ${this.filename} has changed; skipping`;
                new Notice(msg);
                console.error(msg);
                return false;
            }
            text = text.slice(0, start.offset) + text.slice(end.offset);
        }

        if (text !== original) await this.app.vault.modify(file, text);
        if (this.hasFrontMatter) {
            let fmChanged = false;
            await this.app.vault.processFrontMatter(file, frontmatter => {
                for (const key of Object.keys(frontmatter || {})) {
                    if (/^tags?$/i.test(key)) for (const t of tagsToRemove) fmChanged = removeFrontMatterValue(frontmatter, key, t) || fmChanged;
                    else if (/^alias(es)?$/i.test(key)) for (const t of tagsToRemove) fmChanged = removeFrontMatterValue(frontmatter, key, t, true) || fmChanged;
                }
            });
            return text !== original || fmChanged;
        }
        return text !== original;
    }

    replaceInFrontMatter(text, replacements, previewOnly=false) {
        const [empty, frontMatter] = text.split(/^---\r?$\n?/m, 2);
        if (empty.trim() !== "" || !frontMatter.trim() || !frontMatter.endsWith("\n")) return text;
        const parsed = parseDocument(frontMatter, {keepSourceTokens: true});
        if (parsed.errors.length) {
            const error = `YAML issue with ${this.filename}: ${parsed.errors[0]}`;
            console.error(error); new Notice(error + "; skipping frontmatter");
            return text;
        }
        let changed = false;
        const json = parsed.toJSON();

        function setInNode(node, value, afterKey=false) {
            CST.setScalarValue(node.srcToken, value, {afterKey});
            changed = true;
            node.value = value;
        }

        function processField(prop, isAlias) {
            const node = parsed.get(prop, true);
            if (!node) return;
            const field = json[prop];
            if (!field || !field.length) return;
            if (typeof field === "string") {
                let value = field;
                for (const replacement of replacements) {
                    const parts = value.split(isAlias ? /(^\s+|\s*,\s*|\s+$)/ : /(\s+|,)/);
                    value = replacement.inArray(parts, true, isAlias).join("");
                }
                if (field !== value) setInNode(node, value, true);
            } else if (Array.isArray(field)) {
                let values = field.slice();
                for (const replacement of replacements) values = replacement.inArray(values, false, isAlias);
                values.forEach((value, i) => {
                    if (field[i] !== value) setInNode(node.get(i, true), value);
                });
            }
        }

        for (const {key: {value: prop}} of parsed.contents.items) {
            if (/^tags?$/i.test(prop)) processField(prop, false);
            else if (/^alias(es)?$/i.test(prop)) processField(prop, true);
        }
        return changed ? text.replace(frontMatter, CST.stringify(parsed.contents.srcToken)) : text;
    }
}

function removeFromFrontMatterText(text, tags) {
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match) return text;
    const yamlText = match[1];
    const {parseDocument, CST} = requireYaml();
    const parsed = parseDocument(yamlText, {keepSourceTokens: true});
    if (parsed.errors.length) return text;
    const json = parsed.toJSON() || {};
    let changed = false;
    for (const {key: {value: prop}} of parsed.contents?.items || []) {
        const isAlias = /^alias(es)?$/i.test(prop);
        const isTags = /^tags?$/i.test(prop);
        if (!isAlias && !isTags) continue;
        const value = json[prop];
        if (typeof value === "string") {
            const next = value.split(isAlias ? /(^\s+|\s*,\s*|\s+$)/ : /(\s+|,)/).filter((part, i) => {
                if (!part || (isAlias && i % 2 === 1)) return true;
                if (isAlias && !Tag.isTag(part)) return true;
                return !tags.some(tag => Tag.canonical(isAlias ? part : Tag.toTag(part)) === tag.canonical);
            }).join("").replace(/^(?:[\s,]+)|(?:[\s,]+)$/g, "").replace(/\s*,\s*,+/g, ",");
            if (next !== value) {
                const node = parsed.get(prop, true);
                if (next) { CST.setScalarValue(node.srcToken, next, {afterKey: true}); node.value = next; }
                else { parsed.delete(prop); }
                changed = true;
            }
        } else if (Array.isArray(value)) {
            const next = value.filter(v => typeof v !== "string" || !tags.some(tag => Tag.canonical(isAlias ? v : Tag.toTag(v)) === tag.canonical));
            if (next.length !== value.length) {
                const node = parsed.get(prop, true);
                if (next.length) {
                    next.forEach((v, i) => { if (node?.get(i, true)) CST.setScalarValue(node.get(i, true).srcToken, v); });
                    node.items = next;
                } else parsed.delete(prop);
                changed = true;
            }
        }
    }
    if (!changed) return text;
    const rebuilt = `---\n${CST.stringify(parsed.contents.srcToken)}---\n`;
    return text.slice(0, match.index) + rebuilt + text.slice(match.index + match[0].length);
}

function requireYaml() {
    return {parseDocument: parseDocument, CST};
}


function removeFrontMatterValue(frontmatter, key, tag, isAlias=false) {
    const value = frontmatter[key];
    if (typeof value === "string") {
        const parts = value.split(isAlias ? /(^\s+|\s*,\s*|\s+$)/ : /(\s+|,)/);
        const next = parts.filter((part, i) => {
            if (!part || (isAlias && i % 2 === 1)) return true;
            if (!Tag.isTag(part) && isAlias) return true;
            return Tag.canonical(isAlias ? part : Tag.toTag(part)) !== tag.canonical;
        });
        const result = next.join("").replace(/^(?:[\s,]+)|(?:[\s,]+)$/g, "").replace(/\s*,\s*,+/g, ",");
        if (result !== value) {
            if (result) frontmatter[key] = result;
            else delete frontmatter[key];
            return true;
        }
        return false;
    }
    if (Array.isArray(value)) {
        const next = value.filter(v => typeof v !== "string" || Tag.canonical(isAlias ? v : Tag.toTag(v)) !== tag.canonical);
        if (next.length !== value.length) {
            if (next.length) frontmatter[key] = next;
            else delete frontmatter[key];
            return true;
        }
    }
    return false;
}
