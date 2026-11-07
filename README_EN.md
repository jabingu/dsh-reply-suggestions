# Reply Suggestions

[简体中文](./README.md) · **English**

Suggest your next question from the conversation. Press Enter to fill it in, then edit and send.

A composer suggestion plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). After the assistant finishes, a gray suggestion appears in an empty composer. Accept it as an editable draft; it is never sent automatically.

| Item | Current version |
| --- | --- |
| Plugin | `0.1.21` |
| Verified official desktop versions | `0.2.0-rc.2`, `0.2.1-rc.2`, `0.2.1-rc.5`, `0.2.2-rc.1` |
| License | [MIT](./LICENSE) |

## Features

- Generate a relevant follow-up using the latest user question and assistant answer.
- Press **Enter** once to insert the suggestion into the draft. Edit it, then send using Harness's normal behavior.
- Press **Escape** to dismiss the current suggestion.
- Preserve IME confirmation and Shift/Ctrl/Command/Alt+Enter behavior.
- Defer generation while the composer has a draft, attachments, references, or queued work. Hide suggestions while a task is running.
- Reuse the model and credentials already configured in Harness. No additional API key is required.
- View recommendation token usage for today, yesterday, the last 7 days, and the last 30 days on the plugin detail page.

## Demo

![Gray suggestion and first-Enter draft insertion](./assets/reply-suggestions-demo-0.1.16.png)

Generated from the actual 0.1.16 client using its test fixture, then placed in a simulated conversation page. This is not a DSH desktop recording; the conversation and suggestion are demo data, with no model call.

## Installation

### Install from GitHub

1. Open **Plugins** in DSH and check whether `dsh-reply-suggestions` is already installed. If it is, use the update action rather than adding it again.
2. Confirm that the official desktop version falls within the compatibility range below. Version `0.2.2-rc.1` has been checked.
3. Select **Add plugin** and enter this repository address:

   ```text
   https://github.com/jabingu/dsh-reply-suggestions
   ```

4. Follow the app's prompts to load and enable the plugin, then restart DSH.
5. Complete a regular conversation turn, leave the composer empty, and wait for a gray suggestion.

The repository includes prebuilt `lib/` files, so a manual build is unnecessary. The DSH peer range is `0.2.0-rc.2 || >=0.2.1-rc.2 <0.2.2-0 || >=0.2.2-rc.1 <0.2.3-0`: it retains the previous range and adds the 0.2.2 release line from `0.2.2-rc.1`, including later RCs and stable `0.2.2`. All `0.2.3` prereleases and stable releases require a separate interface review. The Cordis range is `~4.0.4 || ~4.1.0`, including `4.1.0` bundled with the new DSH.

If DSH `0.2.2-rc.1` reports that an old plugin is incompatible, update the plugin to the current version, fully exit DSH, then restart it. For a linked local installation, update the linked directory and restart. Existing usage records are retained. Later RCs in the same line are no longer blocked solely by their version number; the versions actually checked are listed above.

### Install from a local directory

Download and extract the repository ZIP, or clone the repository. After checking that the plugin is not installed, enter the absolute path of the directory containing `package.json` in the same Add plugin dialog. Enable it and restart DSH.

The official desktop profile is app-managed; use the desktop Plugins page. If you actually use `dsh web`, run these commands from the plugin directory:

```powershell
dsh plugin --profile web list --depth=0
# Add only after confirming it is not installed:
dsh plugin --profile web add .
```

To update a local linked installation, update its files and restart DSH. There is no need to install it again.

## Example

Send:

> Explain what a plugin is in two or three sentences, with an everyday analogy. Do not use tools or create files.

After the answer, a gray suggestion might say, "Can you show me the simplest plugin example?" Press Enter once to insert it, edit it, and send. The model generates the suggestion, so its exact wording varies with the conversation.

## Models and token usage

Generating a suggestion makes an additional model request. That request consumes usage even if you do not accept it. By default, the plugin uses the provider/model recorded with the assistant answer. When rc.2 records lack that metadata, it falls back to the session's current model projection.

The plugin limits overhead as follows:

- Send only the latest turn's text, excluding the full history, reasoning blocks, and attachment contents.
- Limit the user question to **400 characters** and the assistant answer to **1,200 characters**, on both client and Host.
- Keep roughly the first third and last two thirds of long text, marking the omitted middle. Omit Markdown fenced code locally while keeping surrounding prose and inline code.
- Use a short instruction prompt and an output cap of **96 tokens**. This cap does not include input tokens.
- Disable reasoning for DeepSeek suggestion requests without changing the main conversation's reasoning setting.
- Wait **800 milliseconds** while the composer is available and idle before requesting. Typing during that delay cancels the timer.
- If typing starts after dispatch, hide the suggestion temporarily and reuse the result when the draft is cleared, avoiding cancel-and-retry requests. Switching sessions, starting a new turn, or unloading still cancels the old request.
- Cache up to 64 completed results on the Host and allow at most two concurrent generations.

Compared with the old version, the context cap drops from 14,000 to 1,600 characters, a reduction of about 88.6%. This is not the actual token savings on every request. Compression may omit relevant details from the middle of an answer or its code. No extra model call is used to summarize the context.

## Usage statistics

Open **Plugins → Reply Suggestions** to see lifetime totals plus four periods, including recorded tokens, input (including provider cache)/output tokens, request counts, and missing usage, failures and cancellations.

Individual request details are kept for the most recent **30 calendar days, including today**. Older details are folded into a cumulative summary and removed. Lifetime totals combine that summary with retained details, so cleanup does not reduce totals or add overlapping time windows together. Missing usage/prices remain unknown or partial. Usage from before tracking began cannot be recovered.

Cleanup runs on startup, new writes, statistics reads and hourly checks. It pauses while DSH is closed and catches up after restart. Calendar-day grouping uses the Host's local timezone.

After upgrading, fully exit and restart all DSH instances sharing this data directory so they use the same summary format and writer locks.

The cumulative summary retains token counts, request/status counts and total estimates, rather than older per-request models, price snapshots or identifiers. Costs older than 30 days can no longer be recalculated request by request. Retained details continue to include start times and saved prices.

Two cards keep the panel compact: the left card defaults to today and offers yesterday, last 7 days and last 30 days in a dropdown; lifetime stays on the right. Switching uses the loaded snapshot without extra model calls or statistics requests.

Total, input and output token counts automatically use K (thousands) or M (millions), with up to two decimal places, such as `12K` or `1.23M`. Values below 1,000 remain integers. Stored counts and cost calculations retain full precision.

- Use actual `usage` chunks returned by DSH, not character-based token estimates.
- The last 7/30 calendar days include today and follow the DSH Host's local time zone.
- Count only this plugin's recommendation requests, excluding the main conversation, other plugins, and statistics RPC reads.
- Reusing a completed recommendation makes no new model call and adds no usage. Provider-reported cache tokens still count toward recorded input.
- Multiple cumulative usage chunks replace each other; only the last valid snapshot is recorded once. Usage already returned by a failed/cancelled request counts too. Requests without usage are marked unknown rather than treated as zero.
- Records survive restarts, and the first recorded timestamp is shown. Historical usage from before this feature cannot be recovered.
- Refresh every 15 seconds while the page is open, or click Refresh. Reading statistics does not call a model.

Records live at `storages/dsh-reply-suggestions/usage.jsonl` under the Harness data directory, respecting `DSH_HOME` and defaulting to `~/.dsh`. Profiles sharing that directory share these statistics. The file contains a cumulative summary header when needed, followed by retained details; no conversation text, attachments or credentials. DSH file locks coordinate instances, and summary and retained details are committed together by atomic replacement. Corrupt history defers cleanup while preserving the file and allowing new usage to append. Read/write or cleanup failures remain visible and are retried.

### Cost estimates

Each card shows one CNY API estimate: calculate each request from its start time in Beijing, the holiday calendar and its saved price snapshot, then sum the results. Statistics read local prices; updating prices reads the official webpage without calling a model. Built-in rates below were checked against the [official DeepSeek pricing page](https://api-docs.deepseek.com/zh-cn/quick_start/pricing) on 2026-10-14; time-window rules were checked on 2026-11-01. Rates are CNY per million tokens. After a successful update, new requests use the retrieved rates:

| Model | Uncached input (off-peak/peak) | Cached input (off-peak/peak) | Output (off-peak/peak) |
| --- | --- | --- | --- |
| Flash | 1 / 2 | 0.02 / 0.04 | 4 / 8 |
| Pro | 4.5 / 9 | 0.15 / 0.30 | 13.5 / 27 |

Cost = ((input minus cached input) × selected input rate + cached input × selected cache rate + output × selected output rate) / one million. This estimate is not an actual bill, credit deduction, or subscription charge.

- Use Beijing time: Monday–Friday 09:00–12:00 and 14:00–18:00 are peak windows, with inclusive starts and exclusive ends. Weekends and official holidays are off-peak. Weekend makeup workdays remain off-peak because the official tariff explicitly includes weekends.
- Holidays follow the [State Council's published 2026 day-off periods](https://www.beijing.gov.cn/zhengce/zhengcefagui/202511/t20251104_4258873.html). The bundled calendar currently covers 2026. For uncovered years, weekends and times outside peak windows remain determinable; requests whose tier depends on an unknown holiday calendar remain unpriced until the calendar is updated.
- New records save `startedAt`, the selected tier and the price snapshot. Requests crossing a rate boundary or midnight use their start time for costs and calendar-day grouping. Legacy records use their existing completion timestamp with a visible assumption count; original records are not rewritten.

- Official `deepseek` / `deepseek-account` Flash and Pro use their respective rates; official Flash aliases use Flash rates. Other providers/models are excluded.
- Older 0.1.6/0.1.7 records have no model identifier. Keep them unchanged and label their estimates as assuming Flash. If a different model was used, this assumption does not apply.
- Missing usage, unknown prices/tiers, or requests before the rate's effective date are excluded, not counted as free. Partially priced periods are marked. Individual request amounts are summed.
- New requests freeze a complete price snapshot before generation. Updating during a request does not change its cost; older requests retain their original rates, including the built-in versions used by 0.1.8.
- Small amounts use up to six decimal places. Nonzero amounts below ¥0.000001 remain visible.

### Updating prices

Open **Plugins → Reply Suggestions** and click **更新价格** (Update prices) below recommendation usage. This is independent of the usage Refresh button, which only reads local records. The panel shows the last successful check, next check and errors.

Use the **自动更新周期** (Automatic update interval) dropdown to select daily, every 3 days, weekly (7 days), every 30 days, or manual only. The selection saves and takes effect immediately, survives restart, and keeps the old setting if saving fails. Manual price updates remain available in manual-only mode.

- Automatically check every 7 days by default. The Host checks whether an update is due hourly. First startup or an overdue restart checks immediately; no checks run while DSH is closed.
- Failed automatic checks retry after 24 hours. Manual updates can retry immediately. Concurrent updates in one Host share one request.
- Fetch only `https://api-docs.deepseek.com/zh-cn/quick_start/pricing/` with a 15-second timeout, no API key or conversation data, and no redirects.
- Strictly parse Flash/Pro CNY rates per million tokens, with separate cached input, uncached input and output rates for each tier. Network errors, incompatible currency/units, missing fields or changed markup keep the previous prices with a visible error.
- Check results and rates append to `storages/dsh-reply-suggestions/prices.jsonl` under the Harness data directory and survive restart. Persistence errors are visible.
- Before a UI preference is saved, `autoUpdatePrices` / `priceUpdateDays` provide the defaults (7 days, with 1–30 days supported). Saved UI preferences take precedence, restore from `prices.jsonl`, and are shared by profiles using the same data directory.

## Optional configuration

Defaults usually suffice. To use another model already configured in Harness, override the entry in the active profile's `cordis.patch.yml`:

```yaml
- id: reply-suggestions
  config:
    enabled: true
    timeoutMs: 20000
    autoUpdatePrices: true
    priceUpdateDays: 7
    provider: your-configured-provider
    model: your-configured-model
```

| Option | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Enable suggestion generation |
| `timeoutMs` | `20000` | Timeout in milliseconds, from 1,000 to 60,000 |
| `provider` | Follow conversation | Optional; must be a configured provider |
| `model` | Follow conversation | Optional; must be available from that provider |
| `autoUpdatePrices` | `true` | Automatic price checks; `false` keeps manual updates available |
| `priceUpdateDays` | `7` | Check interval from 1 to 30 days; failures retry after 24 hours |

Failures, timeouts, and invalid output leave normal composer behavior available. Look for `[reply-suggestions]` diagnostics in the client console.

## Development

Development requires Node.js 22 or later. Node 22.23.3 and 24.16.0 have been tested on Windows x64. No build dependencies need to be installed:

```powershell
npm run build
npm test
```

`npm test` enumerates test files explicitly to avoid wildcard expansion differences on Node 22 and Windows. Use `npm test -- --test-reporter=dot` for compact output.

The [Node compatibility](./.github/workflows/test.yml) workflow runs on pushes, pull requests and manual dispatch. It tests Node 22 and 24 on Windows and Linux, checking the build, committed bundle consistency, all tests, client syntax and `npm pack`. The workflow becomes active when pushed to GitHub; local verification does not mean cloud jobs have run.

Desktop plugins use DSH's bundled runtime. These Node checks do not replace desktop visual or real IME acceptance tests.

```text
src/common.mjs       RPC contract, context compression, keyboard safeguards
src/engine.mjs       Model requests, budget, cache, and timeout
src/usage.mjs        Persistent usage records and calendar-day aggregation
src/pricing.mjs      Versioned CNY rates and scalar cost calculations
src/billing-calendar.mjs Beijing billing windows and official holidays
src/price-updates.mjs Official HTML parsing, scheduled checks and price cache
src/index.mjs        Host service registration
src/client.cjs       Gray suggestion, scheduling, draft insertion
lib/                 Prebuilt Host and client files
locale/              Plugin title and Chinese/English descriptions
scripts/build.mjs    Build script with no extra build dependencies
scripts/test.mjs     Cross-platform test file enumeration and runner
.github/workflows/test.yml Windows/Linux automation for Node 22/24
tests/               Behavior and client lifecycle tests
```

The implementation uses official Typert/Gateway RPC, `llm.stream`, the `conversation.input.overlay` slot, session snapshots, and draft actions. Composer DOM markers, draft actions and the detail-page slot have been checked in supported versions and need review when their interfaces change.

## Validation scope

- Version `0.1.21` supports DSH `0.2.2-rc.1` and its Cordis `4.1.0`. Checks use the bundled compatibility evaluator, native file locks and Host/Client RPC libraries to verify loading, recommendations, usage, costs, price updates and restart recovery, with a stub model and price response. Node 22/24 each pass 93 tests. Desktop visual and real IME acceptance have not been repeated.
- Version `0.1.20` limits details to 30 calendar days while preserving cumulative totals. Tests cover day boundaries, repeated cleanup, aggregate merging, concurrency, failed writes and corrupt logs. Real DSH lock helpers verify two independent writer processes and dead-writer lock recovery.
- Version `0.1.19` calculates one amount from each request's start time, holidays and saved prices. Legacy records remain intact with a visible completion-time assumption. Checks cover rate boundaries, timezones, holidays, midnight, price updates, missing calendars and mixed Host/Client versions.
- Version `0.1.18` fixes the exact-version-list rejection on DSH `0.2.1-rc.5`. Its range and boundaries pass both the compatibility evaluator shipped in rc.5 and npm's default SemVer rules. Recommendation, usage, price update and restart RPC checks pass against the new official libraries, using a stub model and price response. Desktop visual and real IME acceptance have not been repeated in this round.
- Version `0.1.17` fixes the load rejection caused by `0.1.16` pinning the old DSH version. It explicitly supports `0.2.0-rc.2` and `0.2.1-rc.2` and passes the compatibility evaluator shipped in the new DSH. New Cordis, Typert, Host/Client Gateway and home-paths libraries verify recommendation RPC, usage, costs, price updates, schedule saving and restart recovery using a stub model and price response. Real records are unchanged; full desktop visual and real IME acceptance have not been repeated on the new release.
- Node 22.23.3 and 24.16.0 each pass 93 automated tests, covering recommendation interaction, placeholder lifecycle, usage/lifetime deduplication, 30-day retention, date boundaries, scalar costs, holidays, price updates, schedule persistence/failure/restart and statistics disposal. Version 0.1.20 verified on 2026-11-01.
- Version `0.1.16` fixes duplicate model calls for concurrent identical requests, overlapping suggestions from duplicate composer mounts, and incorrectly cleared corrupt-price-cache warnings. Both Node versions pass RPC, cache accounting and restart checks using actual rc.2 libraries with a stub model; desktop visual acceptance remains separate.
- Actual plugin fiber mounting, RPC, and disposal were verified using Cordis, Typert, and Host/Client Gateway from the official rc.2 installation, with a stub model.
- Version `0.1.2` was tested in the real rc.2 desktop app for generation, display, first-Enter insertion, editing, Shift+Enter line breaks, sending, Escape, and session switching.
- The `0.1.3` usage optimization and `0.1.4` display metadata update passed automated and resource checks. Real-model quality and desktop visual acceptance were not repeated for those updates.
- Version `0.1.5` adds a transparent PNG chat icon. Dimensions, alpha, the 256 KB limit, and package inclusion have been checked; suggestion and keyboard logic are unchanged.
- Version `0.1.6` was checked against official rc.2 Cordis, Typert, Gateway, and SlotCore for usage RPC, detail registration, and cache accounting. The real desktop detail page showed all four periods; one actual recommendation reported 223 tokens matching its persisted record. Refreshing statistics did not add a model request.
- Version `0.1.7` moves placeholder suppression into the composer component and uses inline screen-reader-only styles, fixing overlapping text when reopening older conversations.
- Version `0.1.8` adds CNY cost ranges. Real historical records of 911 tokens (844 input, 67 output) estimate ¥0.001112–¥0.002224 under the Flash assumption. Official rc.2 RPC and statistics component tests pass; this version has not had a new desktop visual acceptance check.
- Version `0.1.9` adds manual and scheduled updates. Live official-page retrieval, persistence/reload and the real rc.2 Gateway update RPC pass without extra model calls. No new desktop visual acceptance check was performed.
- Version `0.1.10` automatically abbreviates total, input and output token counts to K/M with up to two decimal places.
- Version `0.1.11` adds the interval dropdown. Real rc.2 RPC checks verify saving and Host restart restoration; failures retain previous settings. No new desktop visual acceptance check was performed.
- Version `0.1.12` directly hides native placeholders, observes replacements, and shares suppression leases across instances so old cleanup cannot restore an active placeholder. Desktop restart, return from the plugin page and history switching show one suggestion without overlapping placeholder text.
- Version `0.1.13` adds lifetime totals with K/M formatting and original request prices. Records older than 30 days, duplicates, missing usage, corrupt/future records, the real rc.2 RPC and Host restart restoration are verified. No new desktop visual acceptance check was performed.

Other Harness versions, third-party desktop shells, and real IME candidate selection require additional testing. Suggestions can always be edited or ignored.

## License

[MIT](./LICENSE)
