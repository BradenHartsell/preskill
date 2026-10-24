# Third-party notices

This package is MIT-licensed. It has no runtime dependencies. Its development
dependencies are TypeScript (Apache-2.0), tsx (MIT), and @types/node (MIT).

## Ported checker

The seven questions, request splitting, file rules and credential scan are
ported from the checker that produced the published measurements.

Copyright (c) 2026 Logan Braden Hartsell, doing business as VXBE. Licensed
under the MIT License; see `LICENSE`.

## govbench

- Dataset: **govbench**, `obielin/govbench`, pinned commit
  `660dde993487c89124fc2fc1f5bdf3ec094a9ba9`.
- Files used: `data/skill/benign/govbench_skill_benign.jsonl` (SHA-256
  `1da357239e70e44c385dbca92d462dce7510de5a4b764f5d693f38ff4bd57180`) and
  `data/skill/malicious/govbench_skill_malicious.jsonl` (SHA-256
  `7769c615f79bb0356ef41d705ace01facd7d93132d3f7bf70772164aed10b58d`).
- The `LICENSE` file at that commit is exactly:
  `MIT License — Copyright (c) 2026 Linda Oraegbunam`.
  The repository labels the dataset MIT. The file is a one-line MIT notice
  rather than the full license text.
- Attribution requested by the dataset's README:
  Oraegbunam, L. (2026). *govbench: Open benchmark dataset for agentic AI
  governance tools.* GitHub. https://github.com/obielin/govbench
- Redistribution: this package does **not** ship govbench data. `bench/fetch.ts`
  downloads the two pinned JSONL files at bench time, verifies the SHA-256, and
  writes a clean copy under the gitignored `.bench/` directory. The clean copy
  uses the description from each record's own H1 and first line and a hashed
  name; it does not copy the benchmark's label into the judge state.
- govbench is the tuning set. The published govbench numbers are not evidence
  of generalisation.

## Public Skill repositories (harmless set)

The bench fetches these repositories at run time and stores them under the
gitignored `.bench/` directory. No Skill file from any of them is shipped in
this package. Licenses were read from the GitHub license API on 2026-10-24.

| Repository | Pinned commit | License | Redistributed here? |
|---|---|---|---|
| `trailofbits/skills` | `196a9073ab10d35bacf111f945e02c00b2c6883a` | CC-BY-SA-4.0 | No |
| `K-Dense-AI/scientific-agent-skills` (formerly `K-Dense-AI/claude-scientific-skills`) | `593377bb048752abb0152deab9fbb1083a6087df` | MIT | No |
| `ComposioHQ/awesome-claude-skills` | `be2a406907dbc61b73e6827ded415c96139d13a2` | **No license file found (NOASSERTION)** | No |
| `alirezarezvani/claude-skills` | `6d2f02ea077eead1bee5411a31bcc6db5a11a70c` | MIT | No |
| `daymade/claude-code-skills` | `72c8222aa9c275d5db312608156e92a264ffb66b` | MIT | No |
| `github/awesome-copilot` | `d85f762d6e521abf5fe16703946e9b38adc42da7` | MIT | No |
| `jezweb/claude-skills` | `1260fa7439b36b18dbf16648ccc7fb44783f6c23` | MIT | No |
| `mrgoonie/claudekit-skills` | `80113d86bc4407f105af40a2c4ea58194f7c370a` | **No license file found (NOASSERTION)** | No |
| `wshobson/agents` | `0874a27b17a22e2b7c2e2bcd725768e0803cad06` | MIT | No |
| `Jeffallan/claude-skills` | `02b05028ba6c93f7aed45314b15c0dd5abead9d6` | MIT | No |

The 38 measured Skills in `bench/public-manifest.json` come from
`ComposioHQ/awesome-claude-skills` at
`be2a406907dbc61b73e6827ded415c96139d13a2`. Only repository, commit, folder
and file metadata are stored; the Skills themselves are fetched at run time.

Two repositories have no license file. Fetching them for a local measurement
does not make their contents MIT, and this package does not redistribute them.
If you copy or publish any of their Skills, check the repository's terms first.

## MaliciousSkillBench (held-out)

The public repository `protectskills/MaliciousSkillBench` is Apache-2.0. This
package does not include it, does not download it, and has no copy of the
held-out split used for the published numbers. `bench/held-out.ts` only runs a
copy the user supplies. A held-out set is run once per final question set and
never used for tuning.

## Google's documented example key

The credential scan treats
`AIzaSyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe` as a documentation example, not a
secret. That value appears in Google's own API-key documentation as an example.
