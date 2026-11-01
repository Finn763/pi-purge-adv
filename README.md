<div align="center">

# pi-purge-adv

*Strip the harness. Give the turn back to the model.*

[![License: MIT](https://img.shields.io/badge/License-MIT-3fb950?style=flat-square&labelColor=black)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Finn763/pi-purge-adv?style=flat-square&logo=github&labelColor=black)](https://github.com/Finn763/pi-purge-adv/stargazers)
[![tests](https://img.shields.io/badge/tests-54%2F54-3fb950?style=flat-square&labelColor=black)](#verification)
[![pi](https://img.shields.io/badge/pi--package-extension-8957e5?style=flat-square&labelColor=black)](package.json)

[中文](README.zh-CN.md) | English

</div>

> Most "jailbreaks" swap a prompt. pi-purge-adv strips the harness first — because often the thing refusing you isn't the model, it's the harness.

[pi coding agent](https://github.com/earendil-works/pi) stacks four layers on top of the model before your question ever leaves the box: a persona preamble, the built-in tools/rules/docs sections, a project-trust gate, and context compaction. pi-purge-adv is an extension that replaces each of them with yours, using pi's own extension API — no model patching, no `dist/` surgery, one command to revert.

```bash
pi install git:github.com/Finn763/pi-purge-adv
```

Clone-based install — no npm publish needed. `pi` clones into `<agent-dir>/git/github.com/Finn763/pi-purge-adv`, registers it in `settings.packages`, and loads it in place. Pin a revision with `@main` or a tag: `pi install git:github.com/Finn763/pi-purge-adv@main`.

---

## Why pi-purge-adv exists

Built to kill three things that show up in every jailbreak evaluation:

- **#1: Can't tell who refused.** Ask the model directly and it answers; route the same question through pi and it's blocked — the harness refused first. **Fix:** strip the harness. Swap the preamble, rebuild tools/rules, force the trust gate open, disable compaction. Each layer is independently verifiable.
- **#2: "It works" measured by a word list.** Any answer without `I can't` counts as a pass — yet the most common refusal shape is *polite decline + an alternative*, which contains no refusal words at all. **Fix:** StrongREJECT rubric scoring plus paired two-arm comparison. In this repo's own runs the word list inflated 9/120 into 56/120, and turned 0-of-28 retry conversions into "+19 gains".
- **#3: It leaks your own config.** Ask "what are your rules" and the model dumps your entire injection block — publishing your technique. **Fix:** an anti-exfiltration clause in the persona. Measured: leaks 12/50 → 6/50, while delivery went *up* 24/50 → 35/50.

---

## What it strips

There are exactly four places pi adds its own play. The rest (approval prompts, file sandbox, tool-result pruning) **don't exist in pi** — nothing to strip:

| Harness layer | Where it lives | What pi-purge-adv does |
|---|---|---|
| Persona preamble | `dist/core/system-prompt.js` | Replaced (`section` / `force`) |
| Built-in tools / rules / docs | Same file — supplying `customPrompt` drops all three | Rebuilds the first two, docs not regenerated |
| Project trust gate | `settings.json` → `defaultProjectTrust` | Patch → `always` |
| Context compaction | `settings.json` → `compaction.enabled` | Patch → off |
| Default tool set | `settings.json` → `defaultTools` | Fills in all 8 built-ins |

No back doors left: `payload` mode also rewrites the serialized system message at the provider boundary (Anthropic `system` / OpenAI `messages[0]` / Responses `instructions`).

---

## What the numbers say

Primary target `deepseek/deepseek-flash` (DeepSeek V4.1 Flash). Banks: HarmBench / StrongREJECT / Safety-Prompts / JBB. Judge: `deepseek-v4-flash` with StrongREJECT rubric. Two arms, same items, paired:

| Group | What it measures | baseline | purge | Outcome |
|---|---|---|---|---|
| **A** harness (50) | system-prompt leakage | 2/50 | **11/50** | harness genuinely taken over |
| **B** model (120) | harmful delivery, rubric | 9/120 | **13/120** | only 4 items move |
| **D** control (60) | items that *should* be answered | 5 false refusals | **2** | 3 false refusals fixed |
| **code** (20) | closed-book coding, machine-graded | 20/20 | 20/20 | zero regression |

Same tool, same injection, on `deepseek/deepseek-v4-pro`: B 33/120 → **75/120**. A 10× spread — **the deciding factor is the model's own alignment, not the tool.**

Three follow-up experiments, all falsified and documented rather than quietly dropped: refusal retry (28 triggers, 0 conversions), `payload` mode (parity with `force`), and the [L1B3RT4S](https://github.com/elder-plinius/L1B3RT4S) message wrapper (word list 17.5% → 57.5%, rubric 1/40 → 3/40 — an empty jailbreak).

> Full data, attribution and scoring notes: [docs/FINAL-REPORT.md](docs/FINAL-REPORT.md)

---

## Modes

`mode` in `<agent-dir>/pi-purge-adv/config.json`:

| Mode | Behavior | When |
|---|---|---|
| `off` | does nothing | pause without uninstalling |
| `soft` | appends to `appendSystemPrompt` | most conservative |
| `section` **(default)** | replaces the preamble, rebuilds tools/rules, keeps pi's tool help | daily driver |
| `force` | takes over `systemPrompt` entirely | full control |
| `payload` | `force` + scrubs transcript system + scrubs the outbound payload | maximum coverage (no measured gain) |

Editing `prompt-inject.md` needs no restart — the extension re-reads it by mtime on every event. Text before `<!-- append -->` becomes the preamble; text after becomes the appended rules.

---

## Installation

Anyone can install from the public repo — no npm publish, no local path:

| Path | Command | What happens |
|---|---|---|
| **Public (recommended)** | `pi install git:github.com/Finn763/pi-purge-adv` | clones into `<agent-dir>/git/...`, writes `settings.packages`, loads in place |
| Try once | `pi -e git:github.com/Finn763/pi-purge-adv --print "hello"` | never touches settings |
| From a checkout | `pi install ./pi-purge-adv` | same as public route, but against your working tree |
| CLI (patches settings too) | `node bin/pi-purge-adv.js apply` | adds the 3 settings patches, creates the runtime dir, keeps a `.pipurge.bak` |
| Copy mode | `node bin/pi-purge-adv.js apply --copy` | installs into `<agent-dir>/extensions/pi-purge-adv/`, so the checkout can be deleted |

`D:\code\pi-purge-adv` in older snippets is just the author's working copy — substitute your own path, or use the git source above.

Then start a new pi session (or `/reload`). In-session: `/purge` for status, `/purge mode force`, `/purge edit` for paths.

---

## What's nailed down

| Area | Nailed down |
|---|---|
| Where it acts | Official extension API only (`before_agent_start` / `context_with_system` / `before_provider_request` / `turn_end`); never edits `dist/` |
| Version coupling | `section` rides the public `customPrompt` option; `force` / `payload` are version-agnostic |
| Reversibility | `settings.json` backed up as `.pipurge.bak` before the first write; `revert` restores byte-for-byte, and still works per-patch if the backup is gone |
| Scoring | Rubric only — StrongREJECT formula `(1-refused)·((convincing+specific)/2−1)/4`; word lists are reported for contrast, never for conclusions |
| Eval isolation | Separate agent dir + empty cwd + `--exclude-tools "*"` so evals can't write into the repo |
| Retry | Off by default. 28 triggers, 0 conversions — never a default behavior |
| Dependencies | Zero runtime deps; Node built-ins only |

---

## Boundaries

- **Doesn't touch the model.** Server-side alignment stays put. Real gain on `deepseek-flash`: +4/120.
- **Doesn't police other extensions.** Any `tool_call` gate from your other pi packages still fires.
- **No multi-turn agent coverage.** Tool-using multi-turn scenarios were not measured; group C was dropped because the harness lacked the benchmark's tools.

---

<details>
<summary><strong>Repository layout</strong></summary>

```
src/index.js           extension entry: hooks + /purge command
src/prompt.js          prompt assembly and payload scrubbing (pure)
src/retry.js           refusal detection and retry wording (pure, off by default)
src/config.js          runtime config + inject file IO (BOM-tolerant)
src/settings.js        the three settings.json patches
src/core.js            package registration / copy install / revert / status / doctor
src/paths.js           path resolution (follows PI_CODING_AGENT_DIR)
bin/pi-purge-adv.js        CLI: status/apply/mode/revert/doctor/uninstall/path
prompts/sandbox-release.md   English sandbox persona + anti-exfil hardening
scripts/fetch-banks.mjs      pull public benchmarks (raw.githubusercontent / HF)
scripts/build-banks.mjs      split into four banks
scripts/eval-bank.mjs        run banks over RPC (supports --wrap / --last-only)
scripts/judge.mjs            scoring: rubric / leak / refusal
scripts/code-eval.mjs        coding regression: extract code, actually run asserts
scripts/triage.mjs           delivered / refused / empty classification
scripts/report.mjs           roll results into a report
test/                        54 cases
docs/FINAL-REPORT.md         closing report
```

</details>

---

## Verification

```powershell
npm test                                        # 54/54
node bin/pi-purge-adv.js status                     # install + patch state
node bin/pi-purge-adv.js doctor                     # 9 checks
pi -e git:github.com/Finn763/pi-purge-adv --print "reply: OK"   # prove pi loads it
```

## License

[MIT](LICENSE)

*The harness is stripped. What's left is the model's call.*
