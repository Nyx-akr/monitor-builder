# Dex Builder

A no-code, Max/MSP-style patcher for crypto pages: drop cards and objects on a canvas, wire them together, and data flows along the wires. Live data from [DexScreener](https://docs.dexscreener.com/api/reference) and [CoinGecko](https://docs.coingecko.com).

```bash
npm install
npm run dev
```

## How it works

- **Blocks** (left) — drag onto the canvas, or click to add.
- **Canvas** (center) — drag blocks anywhere; scroll to zoom, drag empty space (or hold Space) to pan. **Right-click** a block for Duplicate / Delete and its own actions (Clear message, Clear token, Output now…), or a wire to delete it.
- **Settings** (right) — edit the selected block; the **Ports** section lists its wires (✕ disconnects).
- **Flow selector** (top right) — switch flows or create a new blank one. Every change autosaves.
- **Preview** — hides the editor chrome.
- **Undo / redo** — **Ctrl+Z** (⌘Z) undoes, **Ctrl+Shift+Z** (⇧⌘Z, or Ctrl+Y) redoes. It covers your edits: adding, moving (a whole drag is one step), duplicating and deleting blocks, connecting and removing wires, *Clear*, and right-panel settings (typing in one field is one step). Data arriving at blocks isn't an edit and is never rolled back — undoing a move doesn't erase what a message box received since. Each flow has its own history (up to 200 steps), starting when it's opened; inside a text field the keys undo the field's typing instead.

## Wires are data flow

Like patch cords in Max/MSP, wires carry real messages from an **outlet** (bottom edge) to an **inlet** (top edge). What's connected is what happens.

- **Connect:** drag from an outlet to an inlet (or the other way).
- **Disconnect:** click a wire and press Delete, or use ✕ in the Ports panel.
- One outlet can feed many inlets; a message is delivered along every wire leaving the outlet.
- Feedback loops stop after 64 hops (a "stack overflow" warning in the console).

### Data types

There are seven data types — signal, text, number, table, **token**, **history**, **OHLCV**. Every port has one (or several), shown by its colour (multi-type ports are striped) and listed in its hover tooltip and the Ports panel:

| Type | Colour | Examples |
| --- | --- | --- |
| signal | grey | Timer `out` — "go now" with no data; goes into a card's `refresh` |
| text | blue | message text, token symbols |
| number | teal | Timer `tick`, Get `out` |
| table | purple | structured data, as rows of named values. **One row** (shown "table · 1 row"): a card's `data` / `info` (a token's details, the market summary), a clicked list row, a Dict box, an error. **Many rows** ("table · 250 rows"): a card's `list`, a Storage's `history`, a Join / Slice / List result. Any table output connects to any table input; blocks take both shapes |
| **token** | **yellow** | **which token** — always its chain and contract address, plus symbol, name, pool, logo (and a price snapshot when a card sent it). From the **Token** block, a click in the Page's token selector, a card's `data`, a row of a card's `list`. Every card's `token` input takes **only** a Token — so DexScreener, GeckoTerminal, RugCheck, GoPlus… all know exactly what to look up. A CoinGecko coin's token carries its contract when it has one (BTC has none). A Token saved before tokens carried their address is completed on the way (the selector and the cards look its symbol up on DexScreener) |
| **history** | lime | **values over time** — dated rows `{ at, data }`, oldest first: a Storage's `history`, DefiLlama's price history. A Chart draws it |
| **OHLCV** | magenta | **candles over time** — dated rows with open / high / low / close (and volume): GeckoTerminal's `list`, CoinGecko's `ohlc`. A Chart draws them as real candles |
| error | orange | card `error` |

A token is a one-row table, and a history / OHLCV a many-row one, so any input taking a table takes them too. Only compatible ports connect: while dragging a wire, ports that can take it glow and the rest fade out and refuse it. Inlets also ignore messages of the wrong type at runtime. A message box's outlet shows the type of what it holds (table, text, number) — and is *anything* while empty, so it can be wired before data arrives. Get's outlet likewise takes the type of the chosen field. Old flows are migrated on load: Bang buttons become Timers (wires kept), wires into a card's old `trigger`/`refresh` inlet move to `token`, and wires from a Condition's old `yes` / `no` outlets move to `result`, and list / dict ports are now table (wires kept).

Data flows through by itself: **every input is hot** — anything arriving produces an output straight away (the only exception is a Timer's `interval`, which just changes its speed). There is no separate trigger/bang logic — the **Timer** is the one source of plain signals (click once, or ▶ to repeat), and a signal reaching a card simply means "fetch with a blank token".

## Project structure

A standard React + TypeScript app (Vite). Each kind of code has its own folder:

```
src/
  main.tsx, App.tsx      app entry and layout (palette · canvas · settings panel)
  styles/global.css      app-wide styles (each block keeps its own .css next to its code)

  apis/                  API blocks — live market data
    coingecko/             CoinGecko card
    dexscreener/           DexScreener card
    jupiter/ goplus/ rugcheck/ honeypot/ kyberswap/ defillama/ geckoterminal/
    shared/                makeApiCard: the common card (token input, data / list / error, badge, results table)
    index.ts               the list of API blocks
  objects/               objects — one folder per object (its code + styles)
    chart/  clock/ (Timer)  condition/  dict/  gate/  get/  join/  list/  message/  slice/  storage/
    index.ts               the list of objects
  page/                  the Page — the screen a flow drives
    page/                  the Page frame and its boxes
    tokenSelector/         the Page's token selector
    widgets/               how a block looks inside a Page box (numbers, text, tables, dicts)
    index.ts
  charts/                the chart module — all chart drawing lives here
    types.ts  options.ts   points, lines, candles · colours, timeframes, styles, candle sizes
    data.ts                history / token lists / numbers → lines; points → candles
    ChartView.tsx          the chart: guide, plot (line / area / candles), axes

  blocks/                the block system
    types.ts               what a block is (BlockDefinition): ports, settings, receive, Render, Widget…
    registry.ts            every block, from apis/ objects/ page/
  components/            editor UI: Canvas, Palette, Inspector, FlowSelector, FetchBadge, Token/Coin search
  hooks/                 React hooks: useFlow (blocks, wires, saving, undo), useRuntime (data along wires), polling
  core/                  editor logic without UI: data types, messages, ports, undo history, Page layout, fetch state
  services/              the outside world: CoinGecko, DexScreener, token lists, storage files (client), chains (what each API calls each chain)
  lib/                   small helpers: number formatting and parsing

server/                  the dev server's file storage (Vite plugins)
  flows.ts               flows/flow_N.json — read / save with revision checks
  storage.ts             flows/storage/*.jsonl — Storage histories
flows/                   your data: flows and storage files
```

### Adding a block

Create a folder in `src/objects/` (or `src/apis/`) with an `index.tsx` exporting a `BlockDefinition` (see `src/blocks/types.ts`): `type`, `label`, `icon`, `category`, `defaultProps`, `settings`, `inlets` / `outlets`, a `receive(ctx, inlet, msg)` handler and a `Render` component (it gets `ctx.send(outlet, msg)` to emit messages); add a `Widget` to make it placeable in Page boxes. Then add it to that folder's `index.ts`. The settings panel builds its form from `settings`, so a block needs no settings UI of its own.

## Blocks

| Block | Inlets | Outlets | Notes |
| --- | --- | --- | --- |
| DexScreener | `token` · `refresh` | `data` · `list` · `info` · `error` | **`token` takes a Token** (from a Token block, the Page's token selector, another card's `data`) and fetches its most traded pair — or its own pool, when the Token carries one; pick a token in the right panel to choose one directly. **`refresh`** takes a signal (e.g. a Timer): it fetches the list, the summary and the selected token again. `data` is the selected token as a Token. Right-click → *Fetch now* does the same. |
| CoinGecko | `token` · `refresh` | `data` · `ohlc` · `list` · `info` · `error` | **`token` takes a Token** and fetches that coin — by its CoinGecko id, or (a DEX token) by its contract, falling back to its symbol; pick a coin in the right panel to choose one directly. **`refresh`** takes a signal: it fetches the list, the summary and the selected coin again. `data` is the coin as a Token, carrying its contract on a known chain when it has one. **`ohlc`** sends the selected coin's candles as OHLCV whenever its data is sent (*OHLC range*: 1 day = 30-minute candles, 7–30 days = 4-hour, 90 days = daily; CoinGecko gives no volume) — wire it into a Chart. |
| Jupiter | `token` · `refresh` | `data` · `list` · `error` | **Solana** token info from Jupiter: price, 24h change, liquidity, market cap, FDV, holders, verified, organic score, mint / freeze authority off, top holders' share. `list` is every token matching the search. *Sell quote ($)*: also asks how much USDC selling that many dollars gets, and the **price impact** — can a position that size actually be exited? |
| GoPlus | `token` · `refresh` | `data` · `error` | **Security check** on EVM chains (Ethereum, BNB, Base, Arbitrum, Polygon, Avalanche, Optimism) and Solana: honeypot, buy / sell tax, open source, mintable, owner can change balances, transfers pausable, blacklist, proxy, creator's share, holders — plus `riskCount` and `risks` (the red flags by name). Solana: mint / freeze / close authorities, changeable balances / metadata. |
| RugCheck | `token` · `refresh` | `data` · `list` · `error` | **Solana rug-risk report**: RugCheck's score, liquidity locked %, the number of risks and the worst level; `list` has each risk (name, level danger / warn, description). |
| honeypot.is | `token` · `refresh` | `data` · `error` | **Simulates a real buy and sell** (Ethereum, BNB Chain, Base): honeypot or not (and why), the overall risk, the **real** buy / sell / transfer tax, holders, and holders who couldn't sell. |
| KyberSwap | `token` · `refresh` | `data` · `error` | **Best swap route** on EVM chains for buying the token with *Buy with (USDC)* dollars: what the tokens received are worth, the **price impact**, gas, hops and the DEXes on the route — a bigger buy shows how deep the liquidity really is. |
| DefiLlama | `token` · `refresh` | `data` · `list` · `error` | *What to fetch*: **Token price + history** — the price (by contract address, CoinGecko id like `bitcoin`, or `chain:address`), and in `list` its history over *History (days)* as dated rows, **ready to wire into a Chart**; or the market's big picture: **chains by TVL**, **protocols by TVL**, **DEXes by 24h volume** (*Top* rows, no token needed — a signal fetches). |
| GeckoTerminal | `token` · `refresh` | `data` · `list` · `error` | **OHLCV candles** for a DEX token's pool (CoinGecko's DEX data): *Candle size* 1 minute – 1 day, *Candles* up to 1000. A token address uses its deepest pool; a DexScreener row brings its own pool (*Pool*). `list` is the candles as **OHLCV**, oldest first, one dated row each with open / high / low / close / volume (`price` = close) — the same shape as a Storage's history, so it **wires straight into a Chart**: Candles style draws the real candles, Line / Area the close. `data`: last close, change over the range, high / low, volume, pool. A young pool only has candles since it was created (a few hours old → a few hours of candles, whatever the size). **Auto-refresh defaults to 60 seconds** so the candles keep moving. A pool that rarely trades has few candles (GeckoTerminal only returns periods with trades), so a short timeframe may show just one or two. The free API allows only a few calls a minute: the card spaces them, waits half a minute after a rate-limit answer (which browsers report as "Failed to fetch") and tries again. |
| Token | `in` · `send` |  `token` | **The one place a flow says which token.** Pick it in the right panel (search by name, symbol or contract address, any chain), or send a Token in (the Page's token selector, a card's `data`) and it becomes the selected one. The box shows its logo, symbol, name, chain, short address and price. **`token` always carries the selected Token** — sent when it changes and when the flow opens — so wire it into any card. **`send`** takes a signal (a Timer, a click on a message box) and pushes the selected Token out again, so every card wired to it asks again. |
| Timer | `in` · `interval` | `out` · `tick` · `done` | The only source of signals. **Click** the box to send one signal; **▶** repeats every *Interval* seconds (set in the right panel; changes apply immediately). `tick` counts from 0; *Count* 0 = forever (default), otherwise it stops after that many and signals `done`. On `in`, `start`/`stop` (or 1/0) control it and anything else arriving sends one signal. Optional *Start when the flow opens*. Keep it slow when it drives CoinGecko. |
| Get | `in` | `out` · `error` | Reads one item from a **table** and passes it straight on. **One row** (a card's `data` / `info`, a Dict, a box showing one): the *Field* dropdown lists every item of the row that arrived, with its type — `symbol · text`, `price · number`, nested tables like `chains` and `chains.solana`. **Many rows** (a card's `list`): a *Row* dropdown appears first — a token by **symbol** (`#0  BTC — Bitcoin`; it follows that token wherever it moves in the list), the **first** or **last row** (whichever it is), or **all rows** — then *Field*: a row + field sends that value (BTC · price → `82,000`), a row with no field sends the whole row, all rows + a field sends that field from every row as a table (all prices). Both start at **none** and nothing is sent until chosen; a choice the new table doesn't have goes back to none. Values go out as their real type (numbers and number text like `$1.02M` as number). A blank signal clears the choices; a duplicated Get starts empty, rewiring clears it, and connecting it to a box already showing a table offers its rows / fields right away. Optional *Round numbers*. A missing row or item goes out of `error`. |
| Join | `in0` … `inN` | `out` | Joins the rows of 2–8 tables (Settings → *Inputs*) into one, in inlet order, and sends it whenever any input receives. A single item joins as a one-item list. Lowering *Inputs* removes the extra inlets and their wires. |
| Slice | `in` | `out` · `rest` | Takes items from a list and passes them on: `out` gets the items (a single item when count is 1), `rest` the others. *From index* is 0-based (0 = first, same numbers a message box shows); negative counts from the end (`-5` = last five). Changing *From* / *Count* re-slices the last list right away. Space-separated text counts as a list. |
| List | `in` · `clear` | `out` · `count` | Collects items: each value arriving on `in` is added (a whole list adds all its items) and the list is sent on. A signal on `clear` empties it (and sends the empty list on). *Max items* keeps only the newest N (0 = no limit) for rolling histories. |
| Storage | `in` | `out` · `history` | Keeps a **dated history** of everything sent to it: each batch arriving (a list, dict, number, text) is saved with the date and time it arrived, and passed straight on out of `out`. Each Storage has its own file, `flows/storage/storage_N.jsonl` (one line per batch), and the box shows how many batches it holds, the **space the file takes** (e.g. `2 batches · 20 KB`) and the newest few with their dates. **History to save** caps the file: only the newest N batches are kept and each new one removes the oldest (0 = keep everything, the default); lowering it deletes the oldest batches over the limit a moment after you stop typing, and the box shows `12 / 100 batches`. `history` sends **all** the stored batches as a History (`{ at, type, data }`, oldest first) as soon as a wire is connected to it, on a **signal**, or right-click → *Send history*. After that, **each new batch is sent on by itself** (*Send each new batch on history*, on by default), and a Chart adds it to the history it already has. |
| Condition | `a` · `b` | `result` | Compares **a** (left input) with **b** (right input) using the *Condition* chosen in the right panel: a > b, a ≥ b, a < b, a ≤ b, a = b, a ≠ b. For a fixed threshold, wire a message box holding the number (e.g. `100000`) into `b`. Both inputs are hot — once both have arrived, every new a or b is checked and `result` sends **1** (true) or **0** (false) — e.g. into a Gate's `control`. The box shows the check with the real values, e.g. `if 222 > 22` (a letter stands in for a value that hasn't arrived: `if 222 > b`), and its border turns **green** when true, **red** when false. Numbers and number text (`$1.02M`, `55%`) compare as numbers, other text alphabetically (ignoring case). Changing the condition re-checks right away. Wires from the old `yes` / `no` outlets move to `result`. |
| Gate | `in` · `control` | `out` | Passes the data arriving on `in` straight on while **open**, and stops it while **closed**. `control` takes a number: **1** opens it, **0** closes it (other values are ignored) — e.g. a Condition's `result`, or a message box holding `1` / `0`. While closed it holds the newest data back, and opening sends that on, so it doesn't matter whether the data or the control arrives first. Closed until the first control value unless *Start open* is on; right-click → *Open* / *Close*. Green border: open, red: closed. Anything passes — values, lists, info, even Timer signals (to switch an API's refresh on and off). |
| Dict | `in` · one per key | `out` | Keeps **named values** together, like a small table: `btc: 82,000 · eth: 3,100`. List the names in Settings → *Keys* (`btc, eth, sol`) and each gets its own input — whatever arrives on it is stored under that name. A one-row table arriving on `in` is merged in (same names replaced); a many-row table is kept row by row under each row's symbol (`BTC: {…}`, `ETH: {…}`); a signal on `in` sends it as it is. Every change sends the whole dict out, so a Get after it can read any value. The box lists the keys (— until a value arrives) and everything it holds; what it holds is saved with the flow, so it survives a reload. Right-click → *Send* / *Clear*. |
| Chart | `line1` … `line6` | — | Draws values over time as **lines, areas or candles** (Settings → *Chart style*; candles show each period's open / high / low / close — *Candle size* 1 minute to 1 day, or automatic: up to 40 candles with several values each; one line is green / red, several keep their colours, hollow when down). Colours: blue, pink, yellow, teal, purple, orange — up to 6 lines. Each input (Settings → *Inputs*, 1–6) takes **only OHLCV or History**: **OHLCV** (GeckoTerminal's `list`, CoinGecko's `ohlc`) is drawn as real candles, or its close as a line; **History** — wire a Storage's `history` in and it's drawn straight away from the stored batches, each at the time it was stored, and redrawn whenever the Storage stores a new one — (Anything else — a number, a card's list, a Get's value over time — goes through a Storage first, which turns it into a History.) **Wiring a source in draws what it last sent straight away** — GeckoTerminal doesn't have to fetch again. What gets plotted: a number as it is; a dict by *Field* (default `price`), under its token's symbol when it's a token; a **list of tokens** (e.g. a Storage of a card's `list`) as **one line per token** — the ones named in *Tokens* (`NUBI, DAWG`; a named token that isn't in the data shows "no data"), or the first 3 of the newest list when that's empty. The **guide** above the plot shows each colour's name, latest value and change over the window. *Timeframe* — also a **dropdown at the chart's top right**, so it can be changed right on the chart (or a Page box): last 5 / 15 minutes, hour, 4 / 24 hours (the default), 7 / 30 days, or everything. *Scale*: one shared scale, or **% change** from each line's first point in view. Points are saved with the flow (up to 1,000 per line); right-click → *Clear chart*. Can be dropped into a Page box. Rows that carry open / high / low / close (GeckoTerminal's `list`) are drawn as **real candles** in Candles style. Drawing lives in `src/charts`. |
| Message | `in` | `out` | Starts empty. **Anything arriving is shown and sent straight on** (lists and dicts shown as clickable rows; a row click sends that item). A signal arriving — or a click — sends the current content; an empty box passes the signal on as a blank token. Edit its text in the right panel. `$1` templates and `a, b` still work. |

### API cards

The newer cards (Jupiter, GoPlus, RugCheck, honeypot.is, KyberSwap, DefiLlama, GeckoTerminal) share one shape (`src/apis/shared/makeApiCard`): a **`token`** input, **`data`** (one row), **`list`** where it has one, **`error`**, a fetch badge and a table of the key results with a one-line verdict (green / yellow / red). The token is **wired in as a Token** (the `token` input takes nothing else; a signal goes into **`refresh`**, which asks again) — from a Token block, the Page's token selector, a card's `data` or a `list` row — or typed in the right panel (*Token*, *Chain*). Plain text like `PONK` isn't enough for cards that need a contract (all but Jupiter and DefiLlama): they say so on the card instead of failing. A token on a chain a card doesn't cover is refused with the reason; a CoinGecko coin without an address is looked up by its contract. Wiring **a token row from another card** — e.g. a DexScreener `data` or a `list` (its first row) — whose chain comes along, so DexScreener → GoPlus checks whatever token is selected. A signal asks again; *Auto-refresh (seconds)* re-asks on its own — skipped while the previous ask is still running, so a slow or rate-limited API never builds a queue; a request that hangs gives up after 20 seconds. All are free and need no API key.

**OHLCV:** CoinGecko has OHLC candles per coin (no volume); DexScreener's public API has none; the **GeckoTerminal** card gives full OHLCV per pool.

### The Page

Every flow has one **Page** block: a full-HD (1920 × 1080) wireframe of the front-end screen this flow is the logic behind. It's added automatically (to the right of the other blocks) and can only be **moved** — no delete, duplicate or palette item, and *Clear* leaves it in place. The Page itself has no inputs or outputs: each widget inside it has its own.

**Boxes.** The left column holds the **Token selector**; to the right are seven empty boxes — four tiles, two panels and one wide box. **Drag a message box, a Dict or a Chart into an empty box** (it lights up while you're over it) and it becomes a widget there, drawn for what it holds:

| It holds | Shown as |
| --- | --- |
| a number | a big figure (`42`, `1.64T`) |
| text | a heading |
| a list of tokens | a table — #, token, name, price, 24h change (+ market cap / liquidity when the list has them) |
| any other list | numbered rows |
| one token's details | a price card — symbol, name, price, 24h change, market cap, volume, liquidity |
| a dict | name → value rows |
| a Chart | the chart, box-sized, with its guide |

A docked widget is still the same block: **its wires stay connected to it**, now on the widget's own edges, data keeps flowing into it, and its settings are in the right panel. Moving the Page moves its widgets. Drag a widget out of the Page (or right-click → *Take out of the Page*) to make it a normal box again. Docking and undocking are undoable.

| Widget | Input | Output | Notes |
| --- | --- | --- | --- |
| Token selector | `tokens` (table) | `token` (token) | Always in the left column (it can't be moved out or deleted). Shows the list wired in (e.g. a card's `list`) with symbol, name, price and 24h change, plus a search box. Clicking a token highlights it and sends it on as a **Token** (chain, address, symbol, name, pool) — so any card wired to it knows exactly which token it is. Right-click → *Send chosen token again*. The list is saved with the flow, and wiring in a message box that already shows a list fills it right away. Rewiring `tokens` clears it. Older flows' wires into the Page's own `tokens` / out of its `token` move here automatically. |

### Card outlets

Send a plain signal (e.g. click a Timer wired in) to a card's `token` — no token needs to be selected — and it fetches and sends:

- **`info`** — the selected token's details (price, liquidity, volume…). With a blank token it's the market summary instead: coins tracked, total market cap, BTC/ETH dominance (CoinGecko); token count, tokens per chain, totals (DexScreener).
- **`list`** — every token in the chosen list (Settings → *List to fetch*), each as one item. **Both cards' list items have exactly the same fields, in the same order**, so anything downstream works the same with either: `source, symbol, name, price, change24h, marketCap, volume24h, liquidity, chain, address, pair, id, url` — `null` where a source has no value (CoinGecko has no chain, address, pair or liquidity; DexScreener no coin `id`). There's no rank: the list's order is the ranking (index 0 = first).
- Token details are also sent whenever a token arrives (even the same one again), and on every refresh unless *Send info out on every update* is off.
- **`error`** (orange) — when a lookup fails (token not found, rate limit…) the card goes blank and sends `{ source, token, error }` here.

Each card shows its API state at the top right: **Fetching…** while a request is in flight, **Updated HH:MM:SS** after an answer, **Error** (reason on hover) after a failure. The wire into a card blinks as soon as a token is delivered; its output wires blink only when the API's answer arrives. Inputs always ask DexScreener fresh (never a cached copy); CoinGecko is asked again unless its answer is under a minute old — its free data doesn't change faster and asking more gets rate-limited — and then the badge shows when that answer was really fetched.

**Hover any outlet** to see what it carries and what it last sent. A card's outlet descriptions follow its settings (e.g. CoinGecko `list` reads "Top 250 coins by market cap" or "Trending…"), and below them **Last sent · time** previews the actual data: `list · 250 items — BTC, ETH, USDT, …`, or an info's first few items (`price: $82.37K`). "Nothing sent yet" means no data has come out of it. Clearing a card's token also clears its `data` preview.

Wire `list` into a message box to see one row per token; click a row to send that token on, e.g. into another card's `token` inlet.

## Flows

Each flow is a file in `flows/` — `flow_1.json`, `flow_2.json`, … — holding its blocks and wires. Files are read and written by the dev server (`server/flows.ts`), so flows need `npm run dev`.

- Saves carry a revision number; if the file changed elsewhere (e.g. a second tab), the save is refused rather than overwriting it — the status shows **Conflict — click to reload**.
- If the dev server is down, the status shows **Offline — retrying** and saving resumes by itself once it's back. Unsaved changes are kept in the browser meanwhile (also across a page reload) and restored if the file hasn't changed since.
- Run the dev server in your own terminal (`npm run dev`) so it doesn't stop when an editor session ends.
- **Storage files** live beside the flows in `flows/storage/` — one `.jsonl` file per Storage, each line `{"at": "2026-10-16T14:50:33.670Z", "type": "list", "data": …}`. They're listed in the left bar under **Storage** with their size: drag one onto any flow to read or add to that history, or right-click it to delete the file. Deleting a Storage block keeps its file.
- Pan/zoom isn't part of the flow — each browser remembers its own view per flow.

## CoinGecko API key (optional)

The keyless tier allows only a few requests per minute, and retrying while blocked extends the block. Dex Builder spaces CoinGecko requests out, pauses them all after a rate-limit response, and caches results. A free [Demo key](https://www.coingecko.com/en/api/pricing) raises the limit to 30/min:

```bash
cp .env.example .env.local   # then paste your key into VITE_COINGECKO_KEY
```
