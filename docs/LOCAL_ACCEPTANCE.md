# Local ChatGPT acceptance

Live verification on 4 October 2026 used the app's own authorized ChatGPT connection, GPT-5.6-Sol, Spanish B1, and the user-entered topic `pluscuamperfect` (recorded verbatim; the standard Spanish term is `pluscuamperfecto`). The test used the actual frontend generators, API routes, Responses stream parser, exercise renderers, and scoring functions. An isolated, capability-protected loopback transport kept test caches separate from the user's lesson. No mock provider responses were used for these results.

| Flow | Requested output | Result | Time |
| --- | --- | --- | --- |
| FIB | 10 items | Passed; 10 scored blanks | 54.0 s including cold source text |
| Multiple choice | 5 items | Passed; 5 scored answers | 23.8 s |
| Cloze | 1 passage | Passed; 8 scored blanks | 95.8 s including cold source text |
| Mixed cloze | 1 passage | Passed; 7 scored blanks | 47.0 s |
| Reading | 1 set | Passed; 5 scored true/false answers | 25.1 s |
| Guided dialogue | 1 dialogue | Passed; rendered prompts and model answers | 15.5 s |
| Writing | 1 set | Passed; rendered prompts and model answers | 8.5 s |
| Rewriting | 5 items | Passed; 5 scored answers | 26.9 s |
| Error bundles | 4 bundles | Passed; 4 scored selections | 33.5 s |
| Structured explanation | 1 explanation | Passed | 15.6 s |
| Streamed explanation | 1 explanation | Passed, including terminal event | 16.2 s |
| Recommendation | 1 next topic | Passed | 4.7 s |
| Answer feedback | 1 explanation | Passed | 14.1 s |

Each scored exercise was checked with its correct answer and an incorrect answer. The harness checks counts, answer keys, renderable controls, and the request's output schema. Guided dialogue, writing, and open-ended reading answers are self-assessment activities. Rendering in this harness is server-side React rendering; it does not establish browser interaction coverage.

An earlier cold FIB run with GPT-6-Astra also produced 10 valid items in 94.7 seconds. Model latency varies. Live checks cover the listed language, level, counts, and models; they are not a guarantee of every possible model output.

The regression suite passes 155 tests, including authentication, account isolation, refresh/logout, failed sign-in cleanup, shutdown cancellation and lock release after a handled authentication write failure, stream inactivity and total deadlines, persisted model selection, chapter failure/retry behavior, exact counts, cache context, invalid answer structures, tutorial dismissal, and PDF export. Production dependency audit: zero known advisories. Existing development-tool advisories are separate from this result.

Authentication fault-injection checks cover failed profile and session writes, errors after file replacement, failed cleanup writes, and unsuccessful provider revocation. Failed sign-ins attempt grant revocation, generation-checked profile cleanup, provisional session deletion, and warning persistence independently. Existing accounts and reused current grants remain protected. Logout remains able to cancel sign-in during the final session-file removal; hosted and local race regressions verify both successful and unsuccessful revocation.

## Browser and PDF checks

A separate browser regression preview replayed the saved live outputs through the actual lesson component. It was labelled as recorded verification and had no account credentials or inference access. FIB rendered ten editable blanks; nine correct answers scored 9/10, then correcting the last answer scored 10/10. The PDF button produced an application/pdf download without an alert.

Tutorial Skip removed the dialog and overlay immediately and saved dismissal. Reloading, starting a lesson, and resetting to language selection did not reopen it. Help explicitly reopened it; Close removed it again. Automated ReactDOM/Joyride checks also cover Finish and timer races.

The full saved lesson exported to a 25-page PDF containing all nine exercise families and complete answer keys. Text extraction, page-bound checks, and visual inspection found no horizontal or vertical text overflow. Adding vertical checks exposed a context line extending into the bottom margin; moving its padding to a container fixed its pagination. Regression coverage includes long answer lines, narrow table cells, the first Markdown table row, and a pagination loop triggered by a wrapping block's bottom margin.

Safari sign-in and live explanation rendering were confirmed earlier in the session; its native automation window subsequently became unavailable. The final tutorial and input-interaction checks used the collaborative browser preview, not a fresh Safari authentication run.

## Reusable checks

`scripts/exercise-acceptance.jsx` exports the acceptance harness. Supply an authenticated same-origin API transport; it does not discover or read credentials. Its callbacks can retain generated educational outputs for inspection without logging prompts or tokens.

`scripts/pdf-acceptance.mjs INPUT_DIRECTORY OUTPUT_DIRECTORY` renders the app's actual PDF document from those outputs, verifies all exercise sections and the answer key, and records page count and text checks. It requires `pdftotext` for content verification. It does not exercise the browser download action.

Image generation remains unsupported by this ChatGPT-plan route according to OpenAI's [current preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations), checked on the same date.
