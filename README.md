# copilot-credit-tracker (`ccred`)

Track where your GitHub Copilot premium-request credits actually go — and whether the
model you picked earned them.

- **Burn rate first.** How much of the monthly allowance is gone, how fast, and what
  the projection says about the rest of the cycle.
- **Session shape.** One-prompt wins vs. five-prompt grinds, and the share of your
  spend that went to follow-ups instead of openers.
- **Prompt length.** Whether longer opening prompts actually buy fewer follow-ups.
- **Token dimensions.** Input, output and context tracked separately, and priced
  separately if your agreement bills that way.
- **Personal and enterprise.** The local ledger always works; `ccred sync` reconciles
  against GitHub's billing usage API for a personal account, an organization or an
  enterprise (including GHES base URLs).

Zero runtime dependencies — Node built-ins only. Nothing to vendor, nothing to audit,
nothing to break an internal registry mirror.

---

## Install

```bash
npm link
```

From then on `ccred` works in any directory. To install from a private registry
instead:

```bash
npm install -g copilot-credit-tracker
```

Requires Node 18.17 or newer.

## Quick start

```bash
ccred init --plan pro --reset-day 14
```

`--reset-day` is the day of the month your Copilot allowance renews — for most
personal plans that is your subscription renewal date, not the 1st.

Log a request as you make it:

```bash
ccred log sonnet "fix the auth redirect loop"
```

Follow-ups on the same problem join the same session automatically:

```bash
ccred p "still looping, here is the middleware"
ccred p "try guarding on the referrer"
ccred end --solved
```

Then look at the damage:

```bash
ccred
```

```
Copilot credits - 2026-08 (Copilot Pro, Aug 14 to Sep 14)

  ██████████░░░░░░░░░░░░░░░░░░░░ 96.33/300 32%
  ███████████████████░░░░░░░░░░░ 64% of the cycle elapsed, 12d left

  pace               95.67 under pace
  burn rate          4.82 credits/day  over 20 active days
  projected          150.52 by Sep 14
  safe daily         16.97 credits/day to finish exactly on budget
  sessions           41 (63% one-prompt, 1.68 prompts avg)

  Claude Opus 4.1    x10       60 cr  62%  6 prompts
  Claude Sonnet 4.5  x1        33 cr  34%  33 prompts
  Claude Haiku 4.5   x0.33   3.33 cr   3%  10 prompts
```

## Commands

### Logging

| Command | What it does |
| --- | --- |
| `ccred log <model> [note]` | Log one premium request. Joins the open session if it is still warm, otherwise starts a new one. |
| `ccred start <model> [label]` | Open a session explicitly. |
| `ccred p [note]` | Log another prompt in the open session (same model unless you pass `--model`). |
| `ccred end [--solved\|--partial\|--wasted]` | Close the open session. The outcome is optional. |
| `ccred undo` | Drop the last logged prompt. |

Optional detail on any log command:

```
--text "…"      measure length from the prompt itself
--file p.md     …or from a file
--stdin         …or from a pipe:  cat prompt.md | ccred log opus --stdin
--chars N       …or state it directly
--words N
--in N --out N --ctx N     input / output / context tokens
--count N       more than one premium request in one go
--multiplier N  override the multiplier (also registers an unknown model)
--tag a,b       free-form tags
--solo          force a standalone one-prompt session
```

A session that has been idle for 45 minutes (configurable) will not swallow your next
prompt — a fresh one starts instead.

### Reporting

| Command | What it does |
| --- | --- |
| `ccred` / `ccred status` | Burn-rate summary for the live cycle. |
| `ccred report [cycle]` | Full analysis: burn, session shape, per-model efficiency, prompt length, tokens. |
| `ccred history [-n 12]` | Every cycle side by side. |
| `ccred export [cycle] --format csv --out usage.csv` | csv, json or ndjson; `--period all` for everything. |

`cycle` is an id like `2026-07`, or `current` / `last`.

Every command accepts `--json` for machine-readable output, so this composes with
whatever dashboard you already have.

### Setup

| Command | What it does |
| --- | --- |
| `ccred init --plan pro --reset-day 14` | Plan, allowance and cycle anchor. |
| `ccred config` | Show every setting. |
| `ccred config set <key> <value>` | Dotted keys, e.g. `github.enterprise`. |
| `ccred config path` | Where the data lives. |
| `ccred models` | Multipliers and plan allowances. |
| `ccred models --set claude-opus-4.1=10` | Correct a multiplier, or register a model GitHub added after this release. |
| `ccred sync` | Reconcile the ledger against GitHub's billing usage API. |

## How the monthly reset works

The live cycle lives in one file. Every command loads it and checks the clock first:

- If the reset day has passed, the finished cycle is written to
  `archive/<cycle-id>.json` and a fresh empty cycle takes its place.
- Any session still open at the boundary is closed **at** the boundary, so work never
  straddles two cycles.
- Several missed cycles roll over in one go — the tool catches up whenever you next
  run it, even if that is three months later.
- A cycle with nothing in it is not archived; an absent file simply means a quiet month.
- Archives are never rewritten by the live cycle, so last month's numbers stay exactly
  as they were.

There is no cron job, no daemon and nothing to remember. Reset day 31 clamps to the
last day of shorter months, and because exactly one cycle begins in each calendar
month, cycle ids stay unique whatever anchor you pick.

Changing `plan` or `allowance` applies to the live cycle immediately. Changing
`cycleResetDay` re-anchors the current cycle without losing what is already logged.

## Where the data lives

Outside this repo and outside your working directory, so it survives across shells,
terminals and projects:

| Platform | Path |
| --- | --- |
| Windows | `%APPDATA%\copilot-credit-tracker\` |
| macOS | `~/Library/Application Support/copilot-credit-tracker/` |
| Linux | `$XDG_DATA_HOME/copilot-credit-tracker/` (or `~/.local/share/…`) |

```
config.json            settings
current.json           the live cycle
archive/2026-07.json   finished cycles, one file each
models.override.json   your multiplier corrections
```

Set `CCRED_HOME` to point somewhere else — the clean way to keep a work profile
separate from a personal one:

```bash
CCRED_HOME=~/.ccred-work ccred status
```

Writes are atomic (temp file plus rename), so an interrupted command cannot leave a
truncated ledger.

## What the efficiency numbers mean

**Re-prompt tax** — the share of your credits spent on prompts *after* the opening one.
A high number means you are paying repeatedly to explain the same problem.

**Credits per session** — the honest cost of finishing something. Only sessions run
entirely on one model count toward that model's figure, so a mixed session cannot
flatter either model. This is the number that answers "is Opus at 10× worth it": a
model that resolves in one prompt at 10× beats one that needs six at 1×.

**Follow-ups by opener length** — sessions bucketed by how long their *first* prompt
was, against how many extra prompts they went on to need. If the terse bucket needs
three follow-ups and the detailed bucket needs none, that is worth knowing.

**Token dimensions** — input, output and context are recorded per prompt and totalled
per model. GitHub bills per premium request rather than per token, so these are
informational by default. If your agreement does price tokens, set the rates and they
are folded into the credit totals:

```bash
ccred config set tokenRates.default.input 0.5    # credits per 1k tokens
ccred config set tokenRates.default.output 1.5
```

## Syncing with GitHub (personal and enterprise)

The local ledger is always the source of truth. `sync` adds GitHub's own count next to
it so you can see drift — requests you forgot to log, or logs that overstate.

```bash
# Personal account
ccred config set github.scope personal
ccred sync

# Organization
ccred config set github.scope organization
ccred config set github.org acme
ccred sync

# Enterprise, incl. GitHub Enterprise Server
ccred config set github.scope enterprise
ccred config set github.enterprise acme-inc
ccred config set github.apiBase https://ghe.acme.example/api/v3
ccred sync
```

Authentication comes from `CCRED_GITHUB_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`, or
`gh auth token` — in that order. The token needs read access to billing ("Plan").
**Tokens are never written to disk by this tool.**

`ccred sync --dry-run` prints the exact URLs it would call and makes no network
requests at all.

A cycle anchored mid-month spans two calendar months; sync fetches both and filters
the line items down to your actual cycle window.

Caveats worth knowing before you trust the drift number:

- The billing usage endpoints require GitHub's enhanced billing platform. Older
  accounts and some GHES versions do not expose them, and sync will say so rather
  than guess.
- Sync is a reconciliation, not a replacement. Nothing in GitHub's report says *which
  prompt* a request belonged to, so session shape, prompt length and per-model
  efficiency can only come from the local ledger.

## Model multipliers

`data/models.json` carries a multiplier table stamped with the date it was accurate
(`asOf`). **GitHub changes these.** Verify against their premium-request documentation
and correct anything stale — corrections are stored in your data directory and survive
upgrades:

```bash
ccred models --set claude-opus-4.1=10
ccred models --set some-new-model=2 --label "Some New Model"
```

Unknown models can also be registered inline the first time you log one:

```bash
ccred log some-new-model "trying it out" --multiplier 2
```

## Development

```bash
npm test          # node:test, no test framework to install
```

Tests cover the cycle maths (including reset-day 31 through February), rollover and
archiving, the metrics engine, argument parsing and the sync helpers.

```
src/core/     period maths, ledger, state + rollover, metrics
src/commands/ one file per command
src/util/     argv parsing, terminal formatting, text measurement
data/         bundled multiplier table
```

`src/index.js` exposes the same pieces programmatically if you want to feed the data
somewhere else.

## License

MIT
