import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

interface PackageJson {
  readonly name?: string;
  readonly version?: string;
  readonly license?: string;
  readonly main?: string;
  readonly types?: string;
  readonly bin?: Readonly<Record<string, string>>;
  readonly files?: readonly string[];
  readonly publishConfig?: { readonly access?: string };
  readonly repository?: { readonly url?: string };
  readonly homepage?: string;
  readonly bugs?: { readonly url?: string };
}

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageJson;
const skill = readFileSync(new URL("../agent/SKILL.md", import.meta.url), "utf8");
const license = readFileSync(new URL("../LICENSE", import.meta.url), "utf8");

test("package metadata points at the built entry points", () => {
  assert.equal(packageJson.name, "@vxbe/preskill");
  assert.match(packageJson.version ?? "", /^\d+\.\d+\.\d+$/u);
  assert.equal(packageJson.license, "MIT");
  assert.equal(packageJson.publishConfig?.access, "public");
  assert.equal(packageJson.main, "./dist/index.js");
  assert.equal(packageJson.types, "./dist/index.d.ts");
  assert.equal(packageJson.bin?.preskill, "./dist/cli.js");
  assert.ok(packageJson.files?.includes("dist"));
  assert.equal(packageJson.repository?.url, "git+https://github.com/BradenHartsell/preskill.git");
  assert.equal(packageJson.homepage, "https://github.com/BradenHartsell/preskill#readme");
  assert.equal(packageJson.bugs?.url, "https://github.com/BradenHartsell/preskill/issues");
});

test("the license names the legal copyright holder", () => {
  assert.match(license, /^Copyright \(c\) 2026 Logan Braden Hartsell, doing business as VXBE$/mu);
});

test("the agent skill ships in the npm package", () => {
  assert.ok(packageJson.files?.includes("agent"));
  assert.match(skill, /^---\nname: preskill\n/u);
  assert.match(skill, /npx @vxbe\/preskill scan/u);
  assert.match(skill, /A missing key, a network error, or a timeout is not a pass/u);
});
