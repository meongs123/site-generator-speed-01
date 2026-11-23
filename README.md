# Fast drop-in makefun-site

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/meongs123/site-generator-speed-01/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/meongs123/site-generator-speed-01/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A fast, dependency-free reimplementation of makefun-site 1.0.0 for the
[make.fun bounty site-generator-speed-01-run-20261122](https://make.fun/bounty/site-generator-speed-01-run-20261122):
it builds the same static site (same front matter dialect, same Markdown
subset, same template dialect, same slug rule, same build report) byte for
byte, only faster.

## Layout

- `solve.js` — ES module exporting `run(input)`, one case's input in, the
  output tree (path → text) out.
- `main.ts` — the harness driver: reads `/input/cases.json`, answers each case
  with `run`, writes `/output/answers.json`.

## Run

```sh
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=/tmp/out node main.ts
```

Node 22. No dependencies, no network, no WASM, no native code, no cache
between cases; two runs over the same set produce byte-identical output.

## License

MIT — see [LICENSE](LICENSE).
