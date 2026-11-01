# Porting notes

The seven question objects in `src/questions.ts` are ported from the checker
that produced the published measurements, question set
`pplx-skill-install-v9`, read at the commit used for the 2026-10-22 run.

Two names were replaced with neutral terms:

- the original assistant name becomes `the agent`;
- the original platform name becomes `the platform`.

Nothing else in the question wording changes. In particular, source pronouns
that refer to the assistant (`he`, `him`, `his`) remain exactly as written, even
where they read awkwardly after the replacement. The checked-in snapshot
`test/fixtures/port-fidelity.snapshot.json` is the complete expected content and
`test/port-fidelity.test.ts` compares against it.

## Where the two replacements appear

| Location | Difference |
|---|---|
| `productContext` | assistant name -> `the agent` (four occurrences); platform name -> `the platform` (two occurrences) |
| `capabilityContext` | assistant name -> `the agent` |
| `documentsDefinition` | assistant name -> `the agent` |
| `skillDefinition` | assistant name -> `the agent` (two occurrences) |
| `personRequestDefinition` | assistant name -> `the agent` |
| `ordinaryWorkBoundary` | assistant name -> `the agent` |
| `judgeTheDoingBoundary` | assistant name -> `the agent` |
| `presentThreatBoundary` | assistant name -> `the agent` |
| `lookAtEveryFileBoundary` | assistant name -> `the agent` |
| `takes_person_data_elsewhere` task and purpose | assistant name -> `the agent` |
| `deceives_the_person` task, purpose and true criteria | assistant name -> `the agent` |
| `hides_actions_from_the_person` task, purpose, boundaries and true/false criteria | assistant name -> `the agent` |
| `harms_other_people` task and purpose | assistant name -> `the agent` |
| `collects_person_secrets` task, purpose and boundaries | assistant name -> `the agent` |
| `runs_harmful_software` task and purpose | assistant name -> `the agent` |
| `overrides_agent_safeguards` task, purpose, boundaries and true/false criteria | assistant name -> `the agent` |
| `overrides_agent_safeguards` true examples | assistant name -> `the agent`; platform name -> `the platform` |
| `deceives_the_person` true example | platform name -> `the platform` |
| `questionReasons` | assistant name -> `the agent` |

The question id changes from `overrides_<assistant>_safeguards` to
`overrides_agent_safeguards` for the same reason: a mechanical replacement of
the assistant's name in an identifier. The id is not question wording, but it is
recorded here because it is visible in the result.

## Package metadata, not question wording

These are specific to this package and are not part of the ported question
objects:

- `questionSetName` is `skill-install-safety-v9-oss`.
- `questionSetContentHash` is recomputed for the neutralized content.
- The default floor is `0.05`.
- `questionReasons` keeps the source's lowercase fragments; `asSentence` is
  applied when they are placed in the typed result and when the CLI prints
  them.
- The judge model defaults are the current Perplexity and OpenRouter ids.

## Verification

`test/port-fidelity.test.ts` fails if any question field changes from the
snapshot. The snapshot contains no assistant or platform names.

## Ruleset v2 (opt-in)

`skillSafetyQuestionsV2` in `src/questions.ts` ports two later revisions of
the same source question set, applied to the v1 objects above:

- v10: the catalog's own verdict is removed from what the judge reads. The
  `source` definition no longer describes `catalog_review`, and the boundary
  about it is dropped from every question. The scanner leaves
  `source.catalog_review` out of the v2 state.
- v11: the description is screened only for an instruction aimed at the
  agent or against the person's safety, never for how broad, persona-like or
  salesy it sounds. `descriptionBoundary` is inserted right after
  `presentThreatBoundary` in every question, and the `skill` definition says
  the name and description are the hint for when to use the Skill.

The same two substitutions as v1 apply to the new text:

| Location | Difference |
|---|---|
| `skill` definition (v2) | assistant name -> `the agent` (three occurrences) |
| `descriptionBoundary` | assistant name -> `the agent` (five occurrences); platform name -> `the platform` (one occurrence) |

The source pronoun `his` in `descriptionBoundary` ("to ignore his
instructions or safeguards") stays as written, for the same reason as in v1.
Nothing else in the v2 wording differs from the source. The checked-in
snapshot `test/fixtures/port-fidelity-v2.snapshot.json` is the complete
expected content, and `test/ruleset-v2.test.ts` compares against it and
checks that every task, purpose, criterion and example is unchanged from v1.

v2 package metadata: `questionSetNameV2` is `skill-install-safety-v11-oss`,
and `questionSetContentHashV2` is recomputed for the neutralized content. The
default floor is the same 0.05.

v2 also ports three deterministic rules from the source checker's file and
link readers, rewritten for this package's own archive and fetch code (no
code is shared):

- archive and compression formats the reader cannot open are refused by
  their leading bytes, before any name-based kind; a v7 tar is recognized by
  its header checksum;
- tar pax and GNU long-name headers are applied to the entry they precede,
  and every name a reader could give the entry must be a safe path; features
  the walk cannot follow are refused;
- bare document names in prose outside fenced code are followed when reading
  a linked Skill.

Two deliberate differences from the source, both because a missing named file
is a hard refusal here: a bare document name the host does not have flags the
Skill (`bareName: true`) instead of refusing it, and a tar's own root
directory entry (`./`) is not treated as an unsafe path.
