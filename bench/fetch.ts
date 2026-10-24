/**
 * Fetch the two benchmark sets at run time. No benchmark Skill file is shipped
 * in this package: every file is downloaded into `.bench/` and gitignored.
 *
 * govbench is the tuning set (MIT, pinned commit 660dde99). Its clean copy
 * takes the description from each record's own H1 and first line and a hashed
 * name, so the benchmark's label never reaches the judge.
 *
 * The public harmless set contains repositories with no license file. They are
 * fetched here, never redistributed. MaliciousSkillBench is not fetched at all;
 * `bench/held-out.ts` runs a copy the user supplies.
 *
 * Usage:
 *   npx tsx bench/fetch.ts govbench
 *   npx tsx bench/fetch.ts public [--max-skills 50] [--repo owner/name]
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  isSkippableSkillFetch,
  skillFilesForFolder,
  writeSkillFiles,
} from "./fetch-lib.js";

const root = join(process.cwd(), ".bench");
const govbenchRoot = join(root, "govbench");
const publicRoot = join(root, "public");

const govbenchPins = {
  benign: {
    url: "https://raw.githubusercontent.com/obielin/govbench/660dde99/data/skill/benign/govbench_skill_benign.jsonl",
    sha256: "1da357239e70e44c385dbca92d462dce7510de5a4b764f5d693f38ff4bd57180",
  },
  malicious: {
    url: "https://raw.githubusercontent.com/obielin/govbench/660dde99/data/skill/malicious/govbench_skill_malicious.jsonl",
    sha256: "7769c615f79bb0356ef41d705ace01facd7d93132d3f7bf70772164aed10b58d",
  },
} as const;

function sha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text)).digest("hex");
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "unknown";
}

async function fetchText(url: string, headers: Record<string, string> = {}): Promise<string> {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    if (response.status === 403 || response.status === 429) {
      const reset = response.headers.get("x-ratelimit-reset");
      throw new Error(
        `GitHub rate limit at ${url}${reset ? `; resets at ${new Date(Number(reset) * 1000).toISOString()}` : ""}. Run again later or use a smaller --repo.`,
      );
    }
    throw new Error(`fetch_failed:${response.status}:${url}`);
  }
  return response.text();
}

interface GovbenchRecord {
  id: string;
  content: string;
  label?: string;
  attack_type?: string | null;
  domain?: string | null;
}

/** The record's own title and first sentence, never its benchmark description. */
function describe(content: string): { title: string; firstLine: string } {
  const lines = content.split(/\r?\n/u);
  const titleLine = lines.find((line) => /^#\s+\S/u.test(line));
  const title = titleLine?.replace(/^#\s+/u, "").trim() ?? "Untitled Skill";
  const titleIndex = titleLine ? lines.indexOf(titleLine) : -1;
  const firstLine =
    lines
      .slice(titleIndex + 1)
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("#") && !line.startsWith("```")) ?? "";
  return { title, firstLine: firstLine.slice(0, 240) };
}

function govbenchSkill(record: GovbenchRecord): { name: string; description: string; content: string } {
  const { title, firstLine } = describe(record.content);
  const description = `${title}${firstLine ? ` — ${firstLine}` : ""}`.slice(0, 1024);
  return {
    name: `gb-${sha256(record.id).slice(0, 16)}`,
    description,
    content: record.content,
  };
}

async function fetchGovbench(force: boolean): Promise<void> {
  if (force) await rm(govbenchRoot, { recursive: true, force: true });
  await mkdir(govbenchRoot, { recursive: true });
  for (const label of ["benign", "malicious"] as const) {
    const pin = govbenchPins[label];
    const text = await fetchText(pin.url);
    if (sha256(text) !== pin.sha256) throw new Error(`govbench_hash_mismatch:${label}`);
    const records = text
      .split(/\r?\n/u)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as GovbenchRecord);
    for (const record of records) {
      const skill = govbenchSkill(record);
      const category =
        label === "benign" ? "benign" : safeSegment(record.attack_type ?? "unknown_attack");
      const folder = join(govbenchRoot, label === "benign" ? "harmless" : "harmful", category, skill.name);
      await mkdir(folder, { recursive: true });
      const manifest = `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n${skill.content}`;
      await writeFile(join(folder, "SKILL.md"), manifest, "utf8");
    }
    process.stdout.write(`${label}: ${records.length} Skills\n`);
  }
  process.stdout.write(`govbench written to ${govbenchRoot}\n`);
}

interface PublicManifestEntry {
  label?: "harmless";
  category: string;
  repository: string;
  commit: string;
  folder: string;
  files: string[];
}

interface PublicSource {
  repository: string;
  commit: string;
  license: string;
  note: string;
}

interface GitHubTreeEntry {
  path: string;
  type: string;
}

async function fetchPublic(options: { maxSkills: number; repo?: string }): Promise<void> {
  const manifestText = await readFile(join(process.cwd(), "bench", "public-manifest.json"), "utf8");
  const manifest = JSON.parse(manifestText.replace(/^\uFEFF/u, "")) as PublicManifestEntry[];
  const sources = JSON.parse(
    await readFile(join(process.cwd(), "bench", "public-sources.json"), "utf8"),
  ) as PublicSource[];
  await mkdir(publicRoot, { recursive: true });

  let written = 0;
  let skipped = 0;
  for (const [index, entry] of manifest.entries()) {
    if (written + skipped >= options.maxSkills) break;
    if (options.repo && entry.repository !== options.repo) continue;
    const destination = join(
      publicRoot,
      "harmless",
      safeSegment(entry.category),
      `${String(index + 1).padStart(2, "0")}-${sha256(`${entry.repository}:${entry.folder}`).slice(0, 10)}`,
    );
    try {
      await writeSkillFiles({
        destination,
        repository: entry.repository,
        commit: entry.commit,
        files: entry.files.map((file) => `${entry.folder}/${file}`),
        sourcePrefix: entry.folder,
      });
      written += 1;
    } catch (error) {
      if (!isSkippableSkillFetch(error)) throw error;
      skipped += 1;
      process.stdout.write(`skipped one manifest Skill: ${error.code}\n`);
    }
  }

  for (const source of sources) {
    if (written + skipped >= options.maxSkills) break;
    if (options.repo && source.repository !== options.repo) continue;
    // The 38 measured Skills above already come from this repository.
    if (source.repository === "ComposioHQ/awesome-claude-skills") continue;
    const treeUrl = `https://api.github.com/repos/${source.repository}/git/trees/${source.commit}?recursive=1`;
    const tree = JSON.parse(
      await fetchText(treeUrl, {
        accept: "application/vnd.github+json",
        "user-agent": "preskill-bench",
      }),
    ) as { tree?: GitHubTreeEntry[] };
    if (!Array.isArray(tree.tree)) throw new Error(`tree_invalid:${source.repository}`);
    const blobs = tree.tree.filter((entry) => entry.type === "blob").map((entry) => entry.path);
    const skillFiles = blobs.filter((path) => path.toLowerCase().endsWith("skill.md"));
    const folders = [...new Set(skillFiles.map((path) => path.split("/").slice(0, -1).join("/")))].sort();
    for (const folder of folders) {
      if (written + skipped >= options.maxSkills) break;
      const files = skillFilesForFolder(blobs, folder);
      if (files.length === 0) continue;
      const destination = join(
        publicRoot,
        "harmless",
        safeSegment(source.repository.replace("/", "-")),
        `${String(written + skipped + 1).padStart(3, "0")}-${sha256(`${source.repository}:${folder}`).slice(0, 10)}`,
      );
      try {
        await writeSkillFiles({
          destination,
          repository: source.repository,
          commit: source.commit,
          files,
          sourcePrefix: folder,
        });
        written += 1;
      } catch (error) {
        if (!isSkippableSkillFetch(error)) throw error;
        skipped += 1;
        process.stdout.write(`skipped one ${source.repository} Skill: ${error.code}\n`);
      }
    }
    process.stdout.write(`${source.repository}: ${folders.length} Skill folders (${source.license})\n`);
  }
  process.stdout.write(`public harmless Skills written to ${publicRoot}: ${written} written, ${skipped} skipped\n`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== "govbench" && command !== "public") {
    throw new Error("usage: bench/fetch.ts govbench|public [--force] [--max-skills N] [--repo owner/name]");
  }
  const force = rest.includes("--force");
  const maxIndex = rest.indexOf("--max-skills");
  const maxSkills = maxIndex >= 0 ? Number(rest[maxIndex + 1] ?? "100000") : 100000;
  if (!Number.isInteger(maxSkills) || maxSkills <= 0) throw new Error("max_skills_invalid");
  const repoIndex = rest.indexOf("--repo");
  const repo = repoIndex >= 0 ? rest[repoIndex + 1] : undefined;
  if (command === "govbench") await fetchGovbench(force);
  else await fetchPublic({ maxSkills, ...(repo ? { repo } : {}) });
}

await main();
