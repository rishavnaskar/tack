# Copy pass, 21 Nov 2026

User-visible strings were pulled from the source with a TypeScript AST walk (JSX text, string and template literals in props, toasts and state messages, three words or more), numbered per screen, and rewritten with `gflash medium`. Every changed line was read before it went in. A line kept its old wording when the rewrite changed a placeholder or a number, grew past the length limit, renamed something the app refers to elsewhere (Read the market, Gap map, Start, Applied, Dry run, demo person, fit), changed what it means, or read worse.

| Screen | Strings | Rewritten | Kept as they were |
| --- | ---: | ---: | ---: |
| Start (with the web preview strip) | 108 | 59 | 49 |
| Market | 26 | 20 | 6 |
| Gap map | 36 | 19 | 17 |
| Plan | 45 | 25 | 20 |
| Portfolio | 30 | 22 | 8 |
| Interview | 93 | 49 | 44 |
| Tracker (with the application kit, apply runs and mail) | 118 | 63 | 55 |
| Progress | 29 | 19 | 10 |
| Autopilot | 57 | 27 | 30 |
| Shell (rail, load states, client errors) | 27 | 16 | 11 |
| Coach routes (409s, server errors, brief, tracker lessons) | 47 | 34 | 13 |
| Coach web preview limits (429s, input checks) | 25 | 19 | 6 |
| Total | 643 | 372 | 271 |

No batch failed. Not covered: two tracker lesson templates with six or more inserted values, labels of one or two words, aria labels, and the demo data.
