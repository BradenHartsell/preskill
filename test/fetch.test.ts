import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchSkillFromUrl, namedSkillFiles, skillManifestAddress } from "../src/fetch.js";
import { skillMd } from "./helpers.js";

function response(text: string, status = 200): Response {
  return new Response(new TextEncoder().encode(text), { status });
}

test("GitHub and raw links become raw SKILL.md addresses without the GitHub API", () => {
  const tree = skillManifestAddress(new URL("https://github.com/o/r/tree/main/skill"));
  assert.equal(tree.url.href, "https://raw.githubusercontent.com/o/r/main/skill/SKILL.md");
  assert.equal(tree.folder.href, "https://raw.githubusercontent.com/o/r/main/skill/");
  assert.equal(tree.sourceType, "github");

  const blob = skillManifestAddress(new URL("https://github.com/o/r/blob/main/skill/SKILL.md"));
  assert.equal(blob.url.href, "https://raw.githubusercontent.com/o/r/main/skill/SKILL.md");

  const repo = skillManifestAddress(new URL("https://github.com/o/r"));
  assert.equal(repo.url.href, "https://raw.githubusercontent.com/o/r/HEAD/SKILL.md");

  const direct = skillManifestAddress(new URL("https://example.test/SKILL.md"));
  assert.equal(direct.sourceType, "direct");
});

test("named files are relative paths and Markdown links, never remote addresses", () => {
  const text = [
    "Read [the notes](references/notes.md).",
    "Run `scripts/run.py` now.",
    "Ignore https://evil.test/remote.md and /absolute/path.md.",
    "A bare package.json is prose, not a Skill file.",
  ].join("\n");
  assert.deepEqual(namedSkillFiles(text, ""), ["references/notes.md", "scripts/run.py"]);
});

test("a linked Skill reads SKILL.md and the files it names, without an Authorization header", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const manifest = skillMd("linked-skill", "A linked skill", "Run [the script](scripts/run.py).");
  const fetcher = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), ...(init ? { init } : {}) });
    if (String(url).endsWith("/SKILL.md")) return response(manifest);
    if (String(url).endsWith("/scripts/run.py")) return response("print('hi')");
    return response("missing", 404);
  };
  const fetched = await fetchSkillFromUrl("https://raw.githubusercontent.com/o/r/main/skill/SKILL.md", { fetch: fetcher as typeof fetch });
  assert.deepEqual(fetched.files.map((file) => file.path), ["SKILL.md", "scripts/run.py"]);
  assert.equal(fetched.source.catalog, "github");
  assert.equal(fetched.missingFiles.length, 0);
  assert.equal(calls.every((call) => !call.init), true);
});

test("a named file the host does not return is reported", async () => {
  const manifest = skillMd("missing-skill", "A missing-file skill", "Run `scripts/run.py`.");
  const fetcher = async (url: string | URL | Request): Promise<Response> => {
    if (String(url).endsWith("/SKILL.md")) return response(manifest);
    return response("not here", 404);
  };
  const fetched = await fetchSkillFromUrl("https://example.test/SKILL.md", { fetch: fetcher as typeof fetch });
  assert.equal(fetched.source.catalog, "web");
  assert.deepEqual(fetched.missingFiles, [{ path: "scripts/run.py", reason: "not_found" }]);
});

test("a named file over the size budget is reported for a typed refusal", async () => {
  const manifest = skillMd("big-skill", "A big-file skill", "Run `scripts/big.py`.");
  const fetcher = async (url: string | URL | Request): Promise<Response> => {
    if (String(url).endsWith("/SKILL.md")) return response(manifest);
    return new Response("x", {
      status: 200,
      headers: { "content-length": String(17 * 1024 * 1024) },
    });
  };
  const fetched = await fetchSkillFromUrl("https://example.test/SKILL.md", { fetch: fetcher as typeof fetch });
  assert.deepEqual(fetched.missingFiles, [{ path: "scripts/big.py", reason: "too_large" }]);
});

test("a manifest that is not UTF-8 text is refused", async () => {
  const fetcher = async (): Promise<Response> => new Response(Uint8Array.from([0xff, 0x00, 0xfe]), { status: 200 });
  await assert.rejects(
    () => fetchSkillFromUrl("https://example.test/SKILL.md", { fetch: fetcher as typeof fetch }),
    /skill_manifest_encoding_invalid/u,
  );
});
