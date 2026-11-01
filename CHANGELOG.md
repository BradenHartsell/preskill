# Changelog

## 0.2.0

Minor release. The default behavior is unchanged: without the new option every
result is the same as 0.1.0, and `questionSetVersion` is still
`skill-install-safety-v9-oss#38554836eb061d76`.

### Added

- Ruleset v2, opt-in through `--ruleset v2`, `PRESKILL_RULESET=v2`,
  `scanSkill(..., { ruleset: "v2" })` and `fetchSkillFromUrl(..., { ruleset: "v2" })`,
  and `--ruleset v2` on the bench. It reports
  `skill-install-safety-v11-oss#b14bc9c5e96937f5`. See "Ruleset v2 (opt-in)" in
  the README for what it changes and the measured trade-off, and PORTING.md for
  provenance.
  - The Skill's description is read only for an instruction aimed at the agent
    or against the person's safety, never for how broad, persona-like or salesy
    it sounds.
  - A catalog's own verdict (`source.catalog_review`) is never sent to the judge.
  - Archive and compression formats the scanner cannot open (7z, RAR, xz,
    bzip2, zstd and others) are refused by their bytes, whatever their name.
  - tar pax and GNU long-name headers are applied and every resulting path is
    checked; tar features the scanner cannot follow are refused.
  - A linked Skill's bare document names (`REFERENCE.md`) are fetched and
    judged; one the host does not have flags the Skill instead of refusing it.
- Exports: `Ruleset`, `rulesets`, `skillSafetyQuestionsV2`, `definitionsV2`,
  `descriptionBoundary`, `questionsForRuleset`, `questionSetNameV2`,
  `questionSetContentHashV2`, `questionSetVersionV2`, `questionSetVersionFor`,
  `namedSkillFileRefs`, `NamedSkillFile`, `unopenedArchiveFormat`,
  `ArchiveReadOptions`, `SkillMissingFile`, `SkillSafetyStateSource`.
- `JudgeOptions.questions`: the questions `scanSkill` wants asked. It is set
  only under v2; `createHttpJudge` sends it.

### Type changes to note

These are additive, but a strict TypeScript consumer may notice them:

- `FileRefusalCode`, `RefusalCode` and `ArchiveRefusalReason` gain
  `"archive format this check cannot open"` and
  `"archive feature that cannot be checked"` (returned only under v2). An
  exhaustive `switch` over these unions needs two new cases.
- `SkillSafetyState.source` is now `SkillSafetyStateSource`, where
  `catalog_review` is optional, because v2 leaves it out. Under v1 it is still
  always present.
- `SkillMissingFile.bareName` is a new optional field.
