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
