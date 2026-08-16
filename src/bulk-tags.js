import { Notice, parseFrontMatterAliases, parseFrontMatterTags } from "obsidian";
import { Progress } from "./progress";
import { File } from "./File";
import { Tag } from "./Tag";
import { Replacement } from "./Tag";

export function transformTag(tag, options) {
    let result = tag;
    if (options.find) result = result.split(options.find).join(options.replace || "");
    return (options.prefix || "") + result + (options.suffix || "");
}

export async function buildRenamePlan(app, tags, options) {
    const pairs = tags.map(tag => ({oldTag: tag, newTag: transformTag(tag, options)}))
        .filter(pair => Tag.canonical(pair.oldTag) !== Tag.canonical(pair.newTag));
    pairs.sort((a, b) => b.oldTag.split("/").length - a.oldTag.split("/").length || b.oldTag.length - a.oldTag.length);
    const replacements = pairs.map(pair => new Replacement(new Tag(pair.oldTag), new Tag(pair.newTag)));
    return buildFilePlan(app, replacements, "rename");
}

export async function buildDeletePlan(app, tags) {
    const tagObjects = tags.map(tag => new Tag(tag));
    const targets = await findTargetsForTags(app, tagObjects, false);
    const files = [];
    for (const target of targets || []) {
        const file = app.vault.getAbstractFileByPath(target.filename);
        if (!file) continue;
        const before = await app.vault.read(file);
        const after = File.renderRemoved(before, tagObjects, target.tagPositions, target.hasFrontMatter);
        if (after !== before) files.push({path: target.filename, before, after});
    }
    return {type: "delete", files, description: `${tags.length} selected tag${tags.length === 1 ? "" : "s"}`};
}

export async function buildFilePlan(app, replacements, type) {
    const files = [];
    const filenames = app.metadataCache.getCachedFiles();
    for (const filename of filenames) {
        const file = app.vault.getAbstractFileByPath(filename);
        if (!file) continue;
        const cache = app.metadataCache.getCache(filename) || {};
        const positions = (cache.tags || []).filter(t => t.tag && replacements.some(r => r.fromTag.matches(t.tag)));
        const relevant = positions.length > 0 || (cache.frontmatter && replacements.some(r =>
            (parseFrontMatterTags(cache.frontmatter) || []).some(v => r.fromTag.matches(v)) ||
            (parseFrontMatterAliases(cache.frontmatter) || []).filter(Tag.isTag).some(v => r.fromTag.matches(v))
        ));
        if (!relevant) continue;
        const before = await app.vault.read(file);
        const after = File.renderRenamed(before, replacements, positions);
        if (after !== before) files.push({path: filename, before, after});
    }
    return {type, files, description: `${replacements.length} tag rename${replacements.length === 1 ? "" : "s"}`};
}

export async function commitPlan(app, plan, journal, summary) {
    let changed = 0;
    for (const snapshot of plan.files) {
        const file = app.vault.getAbstractFileByPath(snapshot.path);
        if (!file) continue;
        const current = await app.vault.read(file);
        if (current !== snapshot.before) {
            new Notice(`Skipped ${snapshot.path}: it changed after preview.`);
            continue;
        }
        await app.vault.modify(file, snapshot.after);
        changed++;
    }
    if (changed) journal.record({type: plan.type, summary: summary || plan.description, files: plan.files});
    new Notice(`${plan.type === "delete" ? "Delete" : "Rename"} complete: ${changed} file(s) updated.`);
    return changed;
}

export async function findTargetsForTags(app, tags, showProgress=true) {
    const targets = [];
    const progress = showProgress ? new Progress("Finding affected files", "Scanning cached files...") : null;
    const files = app.metadataCache.getCachedFiles();
    for (const filename of files) {
        const cache = app.metadataCache.getCache(filename) || {};
        const bodyTags = (cache.tags || []).filter(t => t.tag && tags.some(tag => tag.matches(t.tag))).reverse();
        const frontmatter = cache.frontmatter;
        const fmtags = tags.some(tag => (parseFrontMatterTags(frontmatter) || []).some(value => tag.matches(value)));
        const aliasTags = tags.some(tag => (parseFrontMatterAliases(frontmatter) || []).filter(Tag.isTag).some(value => tag.matches(value)));
        if (bodyTags.length || fmtags || aliasTags) targets.push(new File(app, filename, bodyTags, fmtags || aliasTags));
        if (progress) {
            progress.message = `Scanning ${filename}`;
            if (progress.aborted) break;
        }
    }
    if (progress) progress.close?.();
    return progress?.aborted ? undefined : targets;
}
