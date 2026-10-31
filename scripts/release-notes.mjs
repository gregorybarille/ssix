/**
 * Release notes for a tag, as the release workflow publishes them: what
 * changed since the previous tag, one line per commit with the pull
 * request it came in, then the install steps from .github/release-notes.md.
 *
 *   node scripts/release-notes.mjs v1.0.0-beta.16 > notes.md
 *
 * Commits that touch only CI, tests, docs or tooling are listed apart, so
 * the first list is what users of the app will notice. Needs the full
 * history and tags (`fetch-depth: 0` in CI).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const INSTALL_NOTES = ".github/release-notes.md";

/** Paths that change how the app is built, tested or documented, not the app. */
const BUILD_ONLY = /^(\.github\/|e2e\/|docker\/|docs\/|scripts\/|src\/test\/|AGENTS\.md$|README\.md$)/;

const MERGED_PR = /^Merge pull request #(\d+)/;

/** `git args...` in `cwd`, stdout trimmed. */
function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function lines(text) {
  return text ? text.split("\n") : [];
}

/** The tag before `tag`, or null for the first one. */
function previousTag(cwd, tag) {
  try {
    return git(cwd, "describe", "--tags", "--abbrev=0", `${tag}^`);
  } catch {
    return null;
  }
}

function change(cwd, sha, subject, pr) {
  const files = lines(git(cwd, "diff-tree", "--no-commit-id", "--name-only", "-r", sha));
  return { subject, pr, buildOnly: files.length > 0 && files.every((f) => BUILD_ONLY.test(f)) };
}

/**
 * The changes from the previous tag to `tag`, oldest first. Walks the
 * first-parent history: a merged pull request contributes each of its
 * commits, tagged with its number; a commit made on the branch itself
 * stands alone. `cwd` is the repository.
 */
export function readChanges(tag, cwd = process.cwd()) {
  const previous = previousTag(cwd, tag);
  const range = previous ? `${previous}..${tag}` : tag;
  const changes = [];
  for (const entry of lines(git(cwd, "log", "--first-parent", "--reverse", "--format=%H %P%x09%s", range))) {
    const [ids, subject] = entry.split("\t");
    const [sha, first, second] = ids.split(" ");
    if (!second) {
      changes.push(change(cwd, sha, subject, null));
      continue;
    }
    const pr = subject.match(MERGED_PR)?.[1] ?? null;
    for (const merged of lines(git(cwd, "log", "--no-merges", "--reverse", "--format=%H%x09%s", `${first}..${second}`))) {
      const [mergedSha, mergedSubject] = merged.split("\t");
      changes.push(change(cwd, mergedSha, mergedSubject, pr));
    }
  }
  return { previous, changes };
}

/** The release body: the changes, then `install` (the install steps). */
export function formatNotes({ tag, previous, repo, changes }, install) {
  const line = (c) => `- ${c.subject}${c.pr ? ` (#${c.pr})` : ""}`;
  const app = changes.filter((c) => !c.buildOnly);
  const build = changes.filter((c) => c.buildOnly);
  const out = [];
  if (previous) {
    out.push(`## What's changed since ${previous}`, "");
    out.push(...(app.length > 0 ? app.map(line) : ["No changes to the app itself."]));
    if (build.length > 0) out.push("", "**Build, tests and docs**", "", ...build.map(line));
    out.push("", `**Full diff:** https://github.com/${repo}/compare/${previous}...${tag}`);
  } else {
    out.push("## First release");
  }
  out.push("", "---", "", install.trim(), "");
  return out.join("\n");
}

/** `owner/name`, from Actions or else from the origin remote. */
function repository() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const url = git(process.cwd(), "remote", "get-url", "origin");
  return url.replace(/^.*github\.com[:/]/, "").replace(/\.git$/, "");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const tag = process.argv[2];
  if (!tag) {
    console.error("usage: node scripts/release-notes.mjs <tag>");
    process.exit(2);
  }
  const { previous, changes } = readChanges(tag);
  const install = readFileSync(INSTALL_NOTES, "utf8");
  process.stdout.write(formatNotes({ tag, previous, repo: repository(), changes }, install));
}
