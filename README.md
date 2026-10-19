# Dex Builder

A no-code market monitor for traders and market makers. Pick tokens, get their data, calculate, and show the result on a Page. You build it by dropping blocks on a canvas and wiring them together. Data comes from DexScreener, GeckoTerminal, CoinGecko, GoPlus, RugCheck and honeypot.is, all through a small data engine that runs with the dev server.

```bash
npm install
npm run dev
```

Optional: put `COINGECKO_KEY=…` in `.env` for CoinGecko's higher limits.

## The idea: wires are live formulas

A wire works like a spreadsheet reference: whatever comes out of a block is always the current value. When a token's price updates, everything wired after it recalculates at once. There is no "send" button and no event to trigger. A wire flashes when the value it carries changes.

Data flows **Pick → Data → Calculate → Show → Rules**, and Show blocks dropped into the **Page** become your dashboard.

## Data types

Every port has a type, shown by its colour. A port only accepts the types it lists.

| Type | Colour | What it is |
|---|---|---|
| **Token** | yellow | One token: `chain:address` (or `coingecko:<id>`), symbol, name, logo, main pool |
| **Table** | violet | A list of rows, usually one token per row, with every standard metric as a column |
| **Number** | teal | One value with a unit (USD, %, count, hours, ratio) |
| **Series** | lime | Values over time (`[time, value]` points) |
| **Candles** | pink | OHLCV bars `[time, open, high, low, close, volume]` |
| **Report** | rose | A safety verdict (safe / caution / danger) with flags and facts |
| **Bool** | grey | True or false (an Alert's condition) |
| **Clock** | sky blue | A Clock's pace: refresh every N seconds, or paused |

The standard metrics are `price`, `change5m/1h/6h/24h`, `volume1h/24h`, `liquidity`, `marketCap`, `fdv`, `buys1h`, `sells1h`, `buys24h`, `sells24h`, `txns24h` and `ageHours`. Every token list has them all, so Filter, Sort, Formula and the rest work on any list.

## Blocks

- **Pick**
  - **Token**: wire a token list (e.g. a Feed) into its `list` input and pick from it in the box. Without a list, search in the right panel. A token wired into `in` replaces the picked one.
  - **Feed**: always in the flow (one, movable, not deletable). It has a search box that filters its list and finds tokens on any chain, and a ☆ on every row: starred tokens make your watchlist, and the **☆ Watchlist** toggle at the top shows only them, live, even outside the lists. The watchlist also goes out of `watchlist`. Its right panel has a chain filter (one or several chains), each list's show / timer / pages with its live status, the enrichment timers, and a bar per API showing calls per minute against its limit. It shows token lists from the server's storage. Every source runs on its own timer in the background, ticked or not, and every token it returns is stored; ticking a source only shows it. When a source finishes fetching, the list updates at once (there's no timer on the Feed itself). Click a token and the Feed sends out:
    - `selected`: the token, with its newest values from any source;
    - `history`: its stored history of a chosen metric, updated live;
    - `value`: the latest value of that metric.

    A selected token keeps being updated every 20 s, even after it drops out of every list. The right panel has a timer (0 = off) and a page count for each source, with a live estimate of each API's calls per minute. See *Feed storage* below.
- **Data**
  - **Clock**: sets how fast wired blocks refresh, from 1 s to 1 h, or pauses them. One clock can drive many blocks: wire it into the `clock` input of a Token, Market data, Candles or Token card, and it replaces that block's own refresh setting.
  - **Market data**: the metrics of a token or a list, plus one chosen `value`.
  - **Candles**: OHLCV from GeckoTerminal (CoinGecko for `coingecko:` coins).
  - **History**: a metric over time, from the engine's own recording.
  - **Safety**: GoPlus and RugCheck on Solana; GoPlus and honeypot.is on EVM chains.
- **Calculate**
  - **Merge**, **Common** and **Exclude** combine lists.
  - **Filter**, **Sort** and **Top N** shape a list.
  - **Pick value** takes one number (and its token) from a list.
  - **Aggregate** gives an average, sum, median, min, max or count.
  - **Math** does a + − × ÷ b, % of, or % change. It works on numbers, or on series aligned by time.
  - **Formula** is your own expression. Over a list it adds a new column, e.g. `volume24h / liquidity`.
  - **Change** is the % change over a window. **Moving average** smooths a series.
- **Engine** (the rotation engine's tools; its logic runs on the server, see *The rotation engine* below)
  - **Rotation board**: every evaluated token, ranked by the chosen engine, with phase and call badges, the score, wallets rotating in / out, 2 h flow and round-trip cost. It also shows the tape's coverage per chain. Click a row to select the token, and toggle *BUY only*. Its right panel edits the engine and its rules: BUY / HOLD lines, liquidity band, TIDE veto, safety, trade size, cost cap and hold time, with a reset to Vibe-MM's defaults. Outputs `tokens` (the ranked list) and `buys`.
  - **Market rotation**: per chain, the pools gaining or losing capital (2 h) and the strongest flows between them. Outputs `movers`.
  - **Evaluation**: how each engine's calls did: BUYs, SELLs, how many are graded, average return after 1 h / 6 h / 24 h, and the trade plan's win rate and average; plus the latest graded calls and what's been learned about smart wallets.
- **Show**
  - **Token details**: always in the flow (one, movable, not deletable). Everything about the token selected in the Feed (or a token wired in): market, flow, execution, holders, token facts and a sell simulation. Each value is labelled with its source. In the right panel each field can be shown or hidden, and where several sources have it, the source chosen. The shown fields go out of `details` as a one-row table.
  - **Chart**: line, area or candles, up to 4 inputs, % scale for comparing, and a timeframe menu. Its `marks` input flags moments on it, e.g. Token details' BUY / SELL calls.
  - **Number tile**, **Table**, **Token card** and **Safety card**.
- **Rules**
  - **Alert**: fires when a value goes above or below a level, moves by X%, a new token appears in a list, or a token's value in a list *becomes* something (e.g. the Rotation board's `call` becomes BUY). It can show a browser notification and send to Telegram (set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env`).
  - **Alert log**: every alert that has fired.

Drag a Show block (or the Feed, Token details, Safety or Alert log) onto a box of the **Page** to make it a widget. A new Page is one box: **▦ Edit layout** (above the Page) turns the boxes blue, so you can split any box left/right or top/bottom, drag the dividers to resize, or remove a box. The layout is saved with the flow, and the full-screen dashboard follows it. Older flows keep their original boxes, converted into the same split layout. **⤢ Full screen**, just above the Page, glides into the Page, then opens the **Market Monitor** dashboard. It's a responsive grid of the Page's widgets that fills any screen (ultrawide too, and stacks on narrow ones), under a fixed navbar with the selected token, a clock and *Exit full screen* (or Esc). Widgets scroll with the mouse wheel and react to clicks: clicking a token in the Feed selects it, and Token details follows. **Exit full screen** (or Esc) glides back to the flow. **Preview** hides the editor.

## The data engine (`server/engine.ts`)

The engine is a Vite plugin mounted at `/api/engine`. Blocks never call outside APIs themselves. They ask the engine, which shares requests between blocks, caches them, queues them and backs off when an API rate-limits.

| Endpoint | Source |
|---|---|
| `search?q=` | DexScreener. Ranked by exact match, then 24h volume, so fake-liquidity pools sink. |
| `market?ids=` | DexScreener in batches of 30 (5 s cache), and CoinGecko for `coingecko:` ids |
| `feed?sources=a,b&chain=&limit=&selected=` | The stored lists of those sources, merged, plus each source's timer status, the API budget, the storage size and the selected token's newest row |
| `feed/events` | Live (server-sent events): one event each time a source has fetched, with the tokens it updated |
| `feed/config` (POST) | Each source's timer and pages, and how long history is kept |
| `details?id=&pool=` | Every detail of a token, by source: DexScreener, GeckoTerminal (pool and trade sample), GoPlus, honeypot.is, Jupiter (Solana), KyberSwap or Jupiter $10K quote, DefiLlama. Each source has its own cache and 10 s to answer. |
| `trades[?chain=&pool=]` | The trade tape: per chain, its pools, trades, wallets and wallets seen in 2+ pools; or one pool's trades |
| `rotation[?id=]` | The rotation engine: every evaluated token, best QUALITY score first; or one token's full evaluation: scores with reasons, every engine's call, gates, measures, and the pools capital came from or went to |
| `candles?id=&interval=&limit=` | GeckoTerminal, queued with a 2.5 s gap and a 30 s back-off on 429. CoinGecko OHLC for `coingecko:` ids. |
| `safety?id=` | GoPlus, RugCheck and honeypot.is, merged into one verdict (10 min cache) |
| `history?id=&metric=&hours=` | The engine's own recording |

## Feed storage (`server/collector.ts`)

Every Feed source runs on its own timer for as long as the dev server runs. Its tokens go to `data/history/<token>.jsonl`, one line per change (`{ at, src, m }`), written in batches. Tokens on a Token block, a Token card or selected in a Feed are also watched every 20 s. History, Change and the Feed's `history` output all read these files. `data/` is git-ignored.

- **Default timers** follow each API's documentation:

  | Source | Default | Documented limit |
  |---|---|---|
  | GeckoTerminal trending · new · top | 120 s × 3 pages · 90 s × 2 · 300 s × 1 page on 4 chains | **10 calls/min** for all of GeckoTerminal, candles included; data updates every 60 s; max 10 pages of 20 |
  | DexScreener trending · ads · takeovers | 60 s | 60 requests/min per list; 300/min for token lookups |
  | DexScreener boosts · profiles · Popular | 30 s | (same) |
  | CoinGecko top | 120 s × 2 pages (500 coins) | about 10–30 calls/min keyless or with a demo key; markets update every 60 s |
  | CoinGecko trending | 600 s | updates every 10 min |

- **Queues.** GeckoTerminal requests go out one every 7 s at most (about 8.5 a minute, leaving headroom under its 10), CoinGecko one every 6 s (2 s with a key). The pace adapts: a rate-limit answer pauses the queue for a minute and doubles the gap (up to 60 s), and each success eases it back.
- **Enrichment.** On top of the lists, every stored token gets more values in the background, in the same storage. They're also added to the Feed's rows, so its columns, Filter and Sort can use them:

  | Job | Batch | Default | Adds |
  |---|---|---|---|
  | Jupiter | 100 tokens a call (Solana) | 5 min | organic score and volume, holders, holders Δ 1h, top-10 share |
  | DefiLlama | 50 tokens a call | 5 min | a reference price (→ *Price vs DefiLlama*) |
  | GoPlus | 1 token a call, 10 per run | 1 min; each token every 6 h | holders, top-10 share, buy / sell tax |
  | honeypot.is | 1 token a call, 5 per run (Ethereum, BNB, Base) | 1 min; each token daily | honeypot (sell simulation) |
  | Trade tape | 3 pools per run, any chain (1 GeckoTerminal call each) | 1 min | each pool's last 300 trades, wallet by wallet, kept 6 h in `data/trades/<chain>.json` (one file per chain, because rotation never crosses chains): the rotation engine's input. Chains: Solana, Base, BNB and Ethereum by default (`TAPE_CHAINS` in `.env`), plus any chain your watchlist is on. Each chain's tracked pools come first, then its 10 most-traded; chains take turns, so none is starved. |
  | Rotation engine | every token in the trade tape, chain by chain | 1 min, no API calls | Vibe-MM's rotation engines (`server/rotation.ts`): wallets rotating in/out (1 h), net $, market net flow (2 h) and connected pools, phase (QUIET / WAKING / RUNNING / PEAKING / FADING from the stored 6 h history), ROTATION / MOMENTUM / ORDER FLOW / ROTATION+ / QUALITY / TIDE scores, safety gates, round-trip cost, and a call per engine (BUY / WATCH / SELL / AVOID, with the hold rule). The Feed shows QUALITY ROTATION's call and reason. |
  | Full details | the Feed's watchlist and the token in Token details (its trade analysis reads the trade tape: no GeckoTerminal calls) | 2 min | net buy 5m, organic score from the trade sample, wash probability, $10K impact |

  GeckoTerminal, DexScreener and CoinGecko limits are documented. Jupiter, DefiLlama, GoPlus and honeypot.is publish none for free use, so the budget uses cautious assumed limits. The Feed shows each API's calls per minute and warns near a limit.
- **Only real changes are written.** A token gets a new line only when a value changes; its age, which moves with the clock, doesn't count.
- **Pool.** Each token stays on one pool, so its history doesn't jump between pools.
- `data/feed/config.json` holds the timers, and `data/feed/latest.json` holds each source's last list, so a restart shows data at once.
- History of tokens not updated for *Keep history* days (default 7) is deleted; 0 keeps everything.

## Editor

- Drag blocks from the left, wire an outlet (bottom) to an inlet (top), and select a block to edit it on the right.
- Right-click a block or a wire for its actions.
- Ctrl/⌘+Z undoes and Ctrl/⌘+Shift+Z redoes.
- Flows are saved as JSON in `flows/`, one file per flow, on every change.

## Layout

```
server/        flows.ts (flow files) · engine.ts (data engine + recorder)
src/core/      values · dataTypes · metrics · formula · show · pageLayout · history
src/engine/    client.ts — shared, polled engine queries
src/hooks/     useGraph (live runtime) · useFlow (files, undo, docking)
src/blocks/    pick · data · calc · show · rules · shared · registry
src/page/      the Page
src/charts/    ChartView and its options
```

A block is one object: its `inlets` and `outlets`, an optional `query` (what to ask the engine), an optional `compute` (its outputs from its inputs and data), plus `Render` for the canvas and `Widget` for the Page.

## Next

- Telegram or webhook alerts, and server-side rules that run while the app is closed.
- Market-maker widgets: depth, spread and a price-impact ladder.
- Birdeye or Codex adapters for faster low-cap candles, and websocket push.

## The rotation engine (`server/rotation.ts`, `smart.ts`, `calls.ts`)

A port of Vibe-MM's engine, on our data. Every minute, for every token on the trade tape, chain by chain (rotation never crosses chains):

- **Rotation:** a wallet that sold another token in the last 2 h and bought this one in the last hour rotated *in*; the reverse rotated *out*. We count wallets each way, net $, and the market flow between this pool and every other (2 h, min of both sides).
- **Phase** from the stored 6 h history: QUIET / WAKING / RUNNING / PEAKING / FADING.
- **Twelve engines**, each scoring 0–100:
  - market readers: CYCLE (the 7-input EARLY model), MOMENTUM, SMART MONEY, ORDER FLOW, ROTATION;
  - combinations: BLEND, ROTATION+, CONSENSUS, ROTATION MID-LIQ, SMART ROTATION, QUALITY ROTATION (the default) and TIDE.
- **Calls.** A **call** per engine: PEAKING is SELL, FADING is AVOID. A BUY needs WAKING (or an early RUNNING), the score over the engine's line, the **safety gates** (sellable via honeypot.is on EVM or a Jupiter sell route plus freeze authority on Solana, tax, liquidity floor) and a **round-trip cost** under the cap at the trade size. A hold rule keeps a call through small dips.
- **Smart wallets** are learned from our own tape: every $20+ buy is judged after 6 h (+10 % before −7 % wins). 3+ buys on 2+ tokens winning 40 %+ makes a wallet smart.
- **Evaluation.** Every call change goes into `data/calls/calls.jsonl`, and is graded from the stored prices: the return after 1 h / 6 h / 24 h, and the trade plan's outcome (target, stop or time).
- The rules live in `data/feed/rotation.json` (edited from the Rotation board).

Every number is a floor over the pools the tape has sampled: coverage, GeckoTerminal's 10 calls a minute, is the main limit.
