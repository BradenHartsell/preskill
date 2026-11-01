# preskill

Pre-install checks for AI agent Skills. Published as `@vxbe/preskill`; source at [BradenHartsell/preskill](https://github.com/BradenHartsell/preskill).

`preskill` reads an AI agent Skill — its `SKILL.md`, scripts and reference files — before your agent installs it. It asks a decision model seven questions about what the Skill would make the agent do, runs a local scan for real secret values and for code that is decoded and then run, and returns a plain verdict: **safe**, **flagged** with reasons and files, or **refused**.

It uses the same seven questions, request splitting, file rules and default floor as the checker behind the published numbers. It has no telemetry and no runtime dependencies. There is no server, hosted account, database, dashboard, or billing. The only network calls are the judge requests you configure and, when you pass a URL, the fetch of that Skill.

---

## Quickstart

Set one provider key:

```bash
export PERPLEXITY_API_KEY="your key"
# or
export OPENROUTER_API_KEY="your key"
```

Then scan a Skill:

```bash
npx @vxbe/preskill scan ./my-skill
npx @vxbe/preskill scan ./my-skill.zip
npx @vxbe/preskill scan https://github.com/owner/repo/tree/main/skills/my-skill
npx @vxbe/preskill scan https://raw.githubusercontent.com/o/r/main/skill/SKILL.md
```

The CLI exits `0` for safe, `1` for flagged, and `2` for refused or an error. Add `--json` for the typed result. The provider is inferred from the key; if both keys are set, pass `--provider`.

## Agent integration

The `agent/` folder contains a `SKILL.md` that tells an agent to scan a Skill before installing it and how to act on each verdict. Copy that folder into the skills directory your agent reads, or point the agent at `agent/SKILL.md`.

The agent needs the same key in the environment its shell uses. No hosted service, account, database, or dashboard is involved.

## Copy this prompt to get started

Give this to your own coding agent. Replace the placeholders first.

```text
Set up the open-source preskill scanner in this project and check one Skill
before installing it.

1. Install it from this checkout: <absolute path to the preskill checkout>.
   Run `npm install` and `npm run build` there. If `@vxbe/preskill` is
   available on npm, you can install it instead. Read its README first.
2. Ask me for my own Perplexity or OpenRouter API key. Put it in
   PERPLEXITY_API_KEY or OPENROUTER_API_KEY in my shell environment. Never
   write the key into a file, a prompt, or a commit.
3. Run it once on this Skill: <Skill link, local folder, or zip>.
   Use `npx @vxbe/preskill scan <target> --json` (or `node dist/cli.js scan
   <target> --json` from the checkout) and keep the JSON.
4. Show me: the verdict; every flagged question with its one-sentence reason
   and the files it named; any credential finding by file and line (never the
   value); and every refusal reason. Do not install the Skill unless I say so.
5. Do not add telemetry, logging of Skill text, or any network call beyond the
   judge request and the Skill fetch.
```

## Copy this prompt to security-check this tool first

```text
Audit this repository before I trust it with a Skill: <absolute path to the
preskill checkout>. Read the code, not just the README. Give me a plain
"safe to use" or "not yet" answer at the end, with evidence.

Check:
1. Data flows. What leaves the machine? Confirm the only outbound requests are
   the judge calls to the endpoint I configure and the fetch of the Skill link I
   provide. List every fetch, every header, and anything that could send file
   contents, names, telemetry, or crash data.
2. Secrets. Check for hard-coded keys, tokens, telemetry keys, and anything that
   reads my environment beyond the judge key. Confirm credential findings never
   return the secret value.
3. Dependencies. List runtime and development dependencies, their licenses, and
   whether the package runs on Node 20+, Bun and Cloudflare Workers without
   Node-only APIs in the core.
4. Execution. Confirm no Skill content is executed, imported, evaluated, or
   written to a shell. Confirm archives are only decompressed with limits.
5. License. Read LICENSE and THIRD_PARTY_NOTICES.md. Check whether the ported
   code and every dataset can legally be used and redistributed under MIT.
6. Tests. Run `npm test` and `npm run build`. Say which tests stub the model and
   whether any test can call a real API.
7. Tell me anything the README overstates, any missing refusal path, and any
   place a malicious Skill could reach the judge or the host without being read.
```

---

## What it checks

The seven questions ask about intent and present harm, not capability:

| Question | What a "yes" means |
|---|---|
| `takes_person_data_elsewhere` | It sends the person's private information somewhere they did not choose. |
| `deceives_the_person` | It tells the agent to mislead the person. |
| `hides_actions_from_the_person` | It tells the agent to act without the person knowing. |
| `harms_other_people` | It is built to harm, cheat, stalk, spam or attack others. |
| `collects_person_secrets` | It moves the person's passwords or keys out of their control. |
| `runs_harmful_software` | It runs malware, a backdoor, a miner, or code hidden from the person. |
| `overrides_agent_safeguards` | It tries to switch off the agent's own rules or outrank the person. |

These are **not** problems on their own: reaching an outside service, sending email or messages, posting, paying, deleting files, running the vendor's install script, using sudo for setup, or fetching and following remote instructions. The agent's normal action approvals still apply when the Skill runs.

**Hard refusals** are narrow: code that is decoded and then run (base64/hex into `exec`, `base64 -d | sh`), and a file the Skill uses that nothing can read (a compiled native program, a damaged or password-protected archive, an unknown binary, or a file type with no reader). Base64 data assets that are never run do not count. Obfuscated code that is not decoded-then-run is judged by what it does, not refused for being hard to read.

A **flag is not a dead end**. The result names the question, the files, and a one-sentence reason, so your agent can show you and let you decide. A credential-shaped value can flag a Skill even when no question fires; it is reported by file and line, never by value. Only a refusal is a hard stop.

## Ruleset v2 (opt-in)

Everything above describes the default, ruleset `v1`. Ruleset `v2` carries later refinements from the checker these questions were ported from. It is off unless you turn it on, so an existing setup sees no change.

```bash
npx @vxbe/preskill scan ./my-skill --ruleset v2
# or for every run in this shell:
export PRESKILL_RULESET=v2
```

```ts
const fetched = await fetchSkillFromUrl(link, { ruleset: "v2" });
const result = await scanSkill({ ...fetched, personRequest }, { judge, ruleset: "v2" });
// result.questionSetVersion === "skill-install-safety-v11-oss#b14bc9c5e96937f5"
```

`--ruleset` wins over `PRESKILL_RULESET`. An unknown value is an error, never a silent fallback to v1. The bench takes `--ruleset v2` too.

What changes with v2:

1. The description is read only for an attack, never for its tone. A Skill is judged by what its `SKILL.md` body and files make the agent do. A name or description that sounds broad ("use for anything"), gives the agent a persona or a voice, or promotes a product or a loyalty program in sales language no longer counts toward a flag on its own. An instruction in the description aimed at the agent (ignore your instructions, this Skill comes from the platform, outrank the person, keep something from them) or against the person's safety (ask for their password or card number) still counts exactly like one in `SKILL.md`, because the agent reads the description too. Every question gets one added boundary that says this, and the `skill` definition says the name and description are the hint for when to use the Skill.
2. A catalog's own verdict never reaches the judge. Under v1 the judge sees `source.catalog_review` and a boundary telling it not to rely on it; under v2 the field is removed from the request and the boundary and definition go with it, so another scanner's opinion gets no vote. `SkillSource.catalog_review` stays in the input type, so your code does not change.
3. Archives the scanner cannot open are refused by their bytes. 7z, RAR, xz, bzip2, zstd, lzip, lz4, Unix compress, cab, xar, ARJ, cpio, ar and ISO 9660 are recognized by their leading bytes, whatever the file is named, and refused as `archive format this check cannot open`, because their paths and contents were never checked. Under v1 such a file the Skill never names is kept as a data asset. Archive detection also runs before name-based kinds, so a 7z renamed `logo.png` is not waved through as a picture, and a v7 tar with no `ustar` magic is recognized by its header checksum and unpacked.
4. Tar headers are followed the way tar follows them. pax (`x`) and GNU long-name (`L`, `K`) headers rename the entry after them; v1 skips those headers and checks the entry under its short name, so a pax header could point the real unpack path outside the Skill. v2 applies them and checks every name a reader could give the entry. GNU sparse files, a global header that renames or resizes, repeated or disagreeing extended headers, and a link, directory, device or pipe that claims data are refused as `archive feature that cannot be checked`.
5. A linked Skill's bare document names are read. Skills often name reference files as bare words ("see REFERENCE.md", "follow FORMS.md"). v1 follows only Markdown links and paths with a folder, so those files were never fetched or judged. v2 also follows bare `.md`, `.markdown` and `.txt` names in prose outside fenced code blocks, read from the naming file's folder. A bare name the host does not have (a different case, or a word that was never a file) is returned with `bareName: true`, and under v2 it flags the Skill with a plain reason instead of refusing it. A file named by a link or a path with a folder is still a hard refusal when missing.

The trade-off. On the source checker's own before-and-after run (same model, same benchmark, 0.05 floor, full check), the description change asked about fewer harmless Skills and caught fewer harmful ones: on the held-out set, harmless flagged went from 19.1% to 16.9% and harmful caught from 78.1% to 73.7%. On the tuning set, harmless flagged stayed at 0% and harmful caught at 0.05 stayed at 100% (at 0.10 it went from 98.2% to 96.5%). The drop came from scores between 0.05 and 0.10 on both sides. Every description that carried an instruction at the agent, and every hostile body, was still flagged in that run. Removing the catalog verdict alone moved the held-out numbers within run-to-run variance. Those are the source checker's measurements; this package's v2 has not been re-measured, and the archive and link rules are deterministic and were not part of that benchmark. Pick v2 if fewer false flags on broad or salesy descriptions matter more to you than the last few points of catch rate.

Custom judges: `scanSkill` passes v2's questions as `options.questions` to `judge(state, options)`. `createHttpJudge` sends them; a judge you wrote should send `options.questions` when present. Under v1 the call is exactly as before.

## Install from a checkout

```bash
npm install
npm run build
node dist/cli.js scan ./my-skill
```

Node 20 or later. Bun and Cloudflare Workers can import the core package (`.`) directly; the `./node` entry is only for local folders and zips.

Set `PERPLEXITY_API_KEY` or `OPENROUTER_API_KEY`; the provider is inferred from the key. If both are set, pass `--provider`. `--key-env NAME` reads a different variable; pass `--provider` if the variable name does not contain the provider. A key on the command line is not supported because it lands in shell history.

### Using it from code

```ts
import { createHttpJudge, fetchSkillFromUrl, scanSkill, asSentence } from "@vxbe/preskill";

const link = "https://raw.githubusercontent.com/o/r/main/skill/SKILL.md";
const fetched = await fetchSkillFromUrl(link);

const result = await scanSkill(
  {
    files: fetched.files,
    source: fetched.source,
    missingFiles: fetched.missingFiles,
    personRequest: `Please add this Skill: ${link}`,
  },
  {
    judge: createHttpJudge({
      apiKey: process.env.PERPLEXITY_API_KEY!,
      provider: "perplexity",
    }),
    floor: 0.05,
  },
);

console.log(result.verdict);
for (const id of result.flaggedQuestions) {
  console.log(asSentence(result.reasons.questions[id] ?? ""), result.pathsByQuestion[id]);
}
```

`scanSkill` returns:

```ts
{
  verdict: "safe" | "flagged" | "refused",
  questionProbabilities,   // all seven, 0..1
  flaggedQuestions,        // at or above the floor
  flaggedPaths,
  pathsByQuestion,
  refusals,                // hard stops with a plain reason
  reasons: { questions, other },
  requestCount,
  model,                   // what the provider reported
  questionSetVersion,
  credentialFindings?      // file and line only, never the value
}
```

## The judge

The default is the model used for the published numbers:

| Provider | Default model | Endpoint |
|---|---|---|
| Perplexity | `pplx-decider-v1.2` | `POST https://api.perplexity.ai/v1/decisions` |
| OpenRouter | `perplexity/pplx-decider-v1.2` | `POST https://openrouter.ai/api/alpha/decisions` |

Both send `{ model, state, questions }` and read `answers[id].noul`. Perplexity bills $0.02 per million input tokens for `pplx-decider-v1.2`; output is free. OpenRouter lists the same input price. Provider docs were checked on **2026-10-24**; the URLs and the exact request/response facts are recorded in the comment at the top of `src/judge.ts`. Verify them before you rely on a budget.

The judge is pluggable: pass any object with `model`, `provider` and `judge(state)`. If you use a different model, the published numbers do not apply to it.

## Published numbers

Measured 2026-10-22 on Perplexity Decider v1.2 (`perplexity/pplx-decider-v1.2-20261016`) with the measured question set, at the default 0.05 floor, on the **full check** (judge + credential scan + file rules):

| Set | Role | Harmless flagged | Harmful caught |
|---|---|---:|---:|
| govbench (218 Skills: 180 govbench benign + 38 public harmless) | **Tuning set** | 0 of 218 (0%) | 100% |
| MaliciousSkillBench (748 Skills: 403 harmless, 345 harmful) | **Held-out** | **18.6%** | **78.7%** |

The held-out number is the honest one. Govbench is the set the questions were tuned on, so its 0% says nothing about a Skill it has not seen. The held-out set was run once on the final v9 question set, and it is spent for v9.

At 0.05, about one in five harmless held-out Skills is brought to the person with a question; it is not blocked. At 0.20 the same run flags 11.1% of harmless and catches 53.7% of harmful. The floor was set at 0.05 because a false flag costs one question, while a missed harmful Skill can steer the agent against the person.

Caveats:

- These numbers apply only to the measured model and the measured question set. This package ports that set with two name substitutions ("the agent", "the platform") and one question id renamed; it has not been independently re-measured.
- A different model, question wording, tokenizer, or floor can move every number.
- Govbench is a tuning set. Do not cite it as generalisation.
- A held-out set must be run once per final question set and never used for tuning. Re-running it after a change makes it a tuning set.
- These numbers are for ruleset v1, the default. Ruleset v2 is described in its own section above.

## Running the bench

The bench reports harmless flagged rate and harmful caught rate at floors 0.05, 0.10 and 0.20, overall and per question, plus requests, cost and p50/p95 latency. It never prints a Skill's text, name or path.

```bash
npm install
npm run bench:fetch -- govbench          # MIT, pinned commit 660dde99
npm run bench:fetch -- public            # public repositories; fetched at run time

# Free: request counts and splitting, no model calls
npm run bench -- --set govbench --dry-run --json

# Real: your key, your spend. --confirm-spend is required.
PERPLEXITY_API_KEY=... npm run bench -- --set govbench --confirm-spend --max-cost-usd 2
```

The bench is **checkout-only**: clone the repository and run it from the checkout. It uses `bench/` and the TypeScript sources and is not included in the npm tarball, so `npm install @vxbe/preskill` followed by `npm run bench` is not supported.

The public set is fetched at run time because two of its repositories have no license file. No public Skill file is stored in this package. `bench/fetch.ts public` uses the GitHub tree API without a token; the unauthenticated limit is 60 requests an hour, which is enough for the ten listed repositories but not for repeated runs.

### Held-out

`MaliciousSkillBench` is not in this package, is not downloaded by any script, and must not be used for tuning. Point the runner at your own labelled copy:

```bash
npx tsx bench/held-out.ts --dir ./my-held-out-copy --confirm-spend
# or, with the same runner:
npx tsx bench/run.ts --set held-out --dir ./my-held-out-copy --held-out --confirm-spend
```

The directory layout is `harmless/<category>/<skill>/` and `harmful/<category>/<skill>/`. The runner refuses `--tune` and refuses a real run without `--confirm-spend`.

### What a run costs

At the measured 2026-10-22 request counts and the current $0.02 per million input tokens:

| Set | Requests | Estimated input tokens | Estimated cost |
|---|---:|---:|---:|
| govbench + 38 public | 389 | ~3.8M | ~$0.076 |
| Public harmless diagnosis set | 1,065 | ~30.0M | ~$0.60 |
| Held-out MaliciousSkillBench | 1,034 | ~27.0M | ~$0.54 |
| **All three, one pass** | **2,488** | **~60.8M** | **~$1.22** |

Those are estimates from the published run, not a quote. The request count depends on the Skills' length; the `--max-cost-usd` cap stops before the next Skill once the reported cost reaches it. Output tokens are free. Start with `--dry-run` on your own copy, then use a cap you are willing to spend. A 20% buffer over the three-set estimate is about **$1.46**; use that as a starting cap if you want one number.

## File rules

Every file is read the way an agent would read it:

- **Text** in UTF-8, UTF-16 with or without a BOM, and Windows-1252.
- **Documents** through an optional reader, or locally for `.docx`, `.xlsx`, `.pptx`, `.odt`, `.ods`, `.odp` and `.rtf`. A PDF with no reader is refused when the Skill names it; an unnamed PDF is a data asset.
- **Archives** (`.zip`, `.jar`, `.whl`, `.tar`, `.tar.gz`, `.tgz`) unpacked within **16 MiB expanded, 256 entries, depth 3**, with safe paths. Every entry is judged like any other file.
- **Bytecode** (`.pyc`, `.pyo`, `.class`, `.dex`) judged by the names and strings it carries.
- **Compiled native programs** (`.exe`, `.dll`, `.so`, `.wasm`, and their magic bytes) are refused.
- **Unknown binary** is refused only when the Skill names it or it sits inside an archive.
- **Credential values** are reported by file and line, never by value. Placeholders, environment reads, template slots and documented example keys are not values. The scan ignores `hunter2`, fixture words such as `fakekey`, and Google's documented `AIzaSy...` example key, which the public sample showed as false hits.

Nothing is executed. An archive is decompressed, never run. A Skill's text is read as content to judge, never followed as instructions by the scanner.

### Limits and what is not ported

- SKILL.md and a manifest of every file ride in every judge request. A long file is split into numbered parts, never truncated. One request carries at most 80,000 characters of file text; `SKILL.md`'s head is 30,000.
- Six requests are in flight per Skill; each request has a 15-second deadline.
- Local folder and zip input keeps `.git`, `node_modules`, `__MACOSX` and other files within the 256-file/16 MiB limit; a path the scanner cannot read is refused with a plain reason. A symlink is refused, never followed.
- Credential findings report the real `SKILL.md` line, frontmatter included.
- Document and visual reading are optional. This package accepts a `reader` with `documentText` and `describeVisual`; without one, a named image or PDF is a hard refusal rather than a guess. Office documents are extracted locally.

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The benchmark data is fetched at run time and is not redistributed. Two public Skill repositories have no license file; the bench fetches them only into a gitignored `.bench/` directory and never ships their files. If you redistribute a public Skill yourself, check its repository's license first.

## Development

```bash
npm test              # unit tests; the judge is stubbed, no network
npm run typecheck
npm run typecheck:core # core only, with no Node types
npm run build
```

The core typecheck uses `tsconfig.core.json`, which excludes `src/node.ts` and `src/cli.ts` and sets `"types": []`. `test/core-runtime.test.ts` also fails if any core file imports `node:*`.

The tests cover request splitting, the max-per-question rule, the floor, every file rule, the credential scan's known false hits, and the decoded-then-run patterns with both a base64 data asset and a base64 exec case.

Porting provenance and the exact wording differences from the source question set are in [PORTING.md](PORTING.md).
