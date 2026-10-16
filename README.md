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

## Wires are data flow

Like patch cords in Max/MSP, wires carry real messages from an **outlet** (bottom edge) to an **inlet** (top edge). What's connected is what happens.

- **Connect:** drag from an outlet to an inlet (or the other way).
- **Disconnect:** click a wire and press Delete, or use ✕ in the Ports panel.
- One outlet can feed many inlets; a message is delivered along every wire leaving the outlet.
- Feedback loops stop after 64 hops (a "stack overflow" warning in the console).

### Data types

There are five data types — signal, text, number, list, dict. Every port has one (or several), shown by its colour (multi-type ports are striped) and listed in its hover tooltip and the Ports panel:

| Type | Colour | Examples |
| --- | --- | --- |
| signal | yellow | Timer `out` — "go now" with no data (a blank token) |
| text | blue | message text, token symbols |
| number | teal | Timer `tick`, Get `out` |
| list | purple | card `list` outlets |
| dict | pink | named values (name → value): card `data` / `info` (a token's details or the market summary), a clicked list row, a Dict box, an error |
| error | orange | card `error` |

Only compatible ports connect: while dragging a wire, ports that can take it glow and the rest fade out and refuse it. Inlets also ignore messages of the wrong type at runtime. A message box's outlet shows the type of what it holds (dict, list, text, number) — and is *anything* while empty, so it can be wired before data arrives. Get's outlet likewise takes the type of the chosen field. Old flows are migrated on load: Bang buttons become Timers (wires kept), wires into a card's old `trigger`/`refresh` inlet move to `token`, and wires from a Condition's old `yes` / `no` outlets move to `result`.

Data flows through by itself: **every input is hot** — anything arriving produces an output straight away (the only exception is a Timer's `interval`, which just changes its speed). There is no separate trigger/bang logic — the **Timer** is the one source of plain signals (click once, or ▶ to repeat), and a signal reaching a card simply means "fetch with a blank token".

## Blocks

Blocks live in folders and are discovered automatically — add a folder to add a block, delete it to remove one.

```
src/blocks/
  cards/
    tokenCard/   DexScreener
    coinCard/    CoinGecko
  objects/
    message/     Message box
    slice/       Slice (take items from a list)
    clock/       Timer (click: one signal · ▶: repeat)
    join/        Join (combine lists)
    get/         Get (read a number from data)
    list/        List (collect items)
    storage/     Storage (dated history, saved to a file)
    condition/   Condition (if a > b, a = b, …)
    gate/        Gate (pass or stop data)
    dict/        Dict (keep named values together)
```

| Block | Inlets | Outlets | Notes |
| --- | --- | --- | --- |
| DexScreener | `token` | `data` · `list` · `info` · `error` | Text (address or symbol, e.g. `PEPE`; `solana BONK` pins a chain) or a token item fetches that token's best-matching, most traded pair (ranked by 24h volume; text matching no symbol/name is "not found"). A plain **signal** is a blank token: it **clears** the selected token and fetches the list and info. Right-click → *Fetch now* refreshes everything without clearing. |
| CoinGecko | `token` | `data` · `list` · `info` · `error` | Text (CoinGecko id, symbol or name, e.g. `btc`) or a token item fetches that coin — resolved from the saved Top 250 first, so common coins cost no request. A plain **signal** is a blank token: it **clears** the selected coin and fetches the list and info. |
| Timer | `in` · `interval` | `out` · `tick` · `done` | The only source of signals. **Click** the box to send one signal; **▶** repeats every *Interval* seconds (set in the right panel; changes apply immediately). `tick` counts from 0; *Count* 0 = forever (default), otherwise it stops after that many and signals `done`. On `in`, `start`/`stop` (or 1/0) control it and anything else arriving sends one signal. Optional *Start when the flow opens*. Keep it slow when it drives CoinGecko. |
| Get | `in` | `out` · `error` | Reads one item from a **dict** (a card's `data` / `info`, a Dict box, or a message box showing a dict) and passes it straight on. The *Field* dropdown lists **every item** of the dict that reached this Get, with its type — e.g. `symbol · text`, `price · number`, nested dicts like `chains` and its `chains.solana` — and is **none** until you pick one. The value goes out as its real type: numbers (and number text like `55%` / `$1.02M`) as number, other text as text, nested dicts as dict; `out`'s type follows the chosen field. If a new dict lacks the picked item it goes back to **none**. A blank signal (e.g. clicking an empty message box) clears its fields. A duplicated Get starts empty, rewiring clears its list, and connecting it to a box already showing a dict lists that box's items right away. Optional *Round numbers*. A missing item goes out of `error`. |
| Join | `in0` … `inN` | `out` | Joins 2–8 lists (Settings → *Inputs*) into one, in inlet order, and sends it whenever any input receives. A single item joins as a one-item list. Lowering *Inputs* removes the extra inlets and their wires. |
| Slice | `in` | `out` · `rest` | Takes items from a list and passes them on: `out` gets the items (a single item when count is 1), `rest` the others. *From index* is 0-based (0 = first, same numbers a message box shows); negative counts from the end (`-5` = last five). Changing *From* / *Count* re-slices the last list right away. Space-separated text counts as a list. |
| List | `in` · `clear` | `out` · `count` | Collects items: each value arriving on `in` is added (a whole list adds all its items) and the list is sent on. A signal on `clear` empties it (and sends the empty list on). *Max items* keeps only the newest N (0 = no limit) for rolling histories. |
| Storage | `in` | `out` · `history` | Keeps a **dated history** of everything sent to it: each batch arriving (a list, dict, number, text) is saved with the date and time it arrived, and passed straight on out of `out`. Each Storage has its own file, `flows/storage/storage_N.jsonl` (one line per batch), and the box shows how many batches it holds, the **space the file takes** (e.g. `2 batches · 20 KB`) and the newest few with their dates. **History to save** caps the file: only the newest N batches are kept and each new one removes the oldest (0 = keep everything, the default); lowering it deletes the oldest batches over the limit a moment after you stop typing, and the box shows `12 / 100 batches`. A **signal** sends the history out of `history` as a list of `{ at, type, data }`, oldest first (*History to send*: the newest N, 0 = all). Placing a Storage creates a new file; a duplicate gets its own new file too. Right-click → *Send history* / *Clear history…*. |
| Condition | `a` · `b` | `result` | Compares **a** (left input) with **b** (right input) using the *Condition* chosen in the right panel: a > b, a ≥ b, a < b, a ≤ b, a = b, a ≠ b. For a fixed threshold, wire a message box holding the number (e.g. `100000`) into `b`. Both inputs are hot — once both have arrived, every new a or b is checked and `result` sends **1** (true) or **0** (false) — e.g. into a Gate's `control`. The box shows the check with the real values, e.g. `if 222 > 22` (a letter stands in for a value that hasn't arrived: `if 222 > b`), and its border turns **green** when true, **red** when false. Numbers and number text (`$1.02M`, `55%`) compare as numbers, other text alphabetically (ignoring case). Changing the condition re-checks right away. Wires from the old `yes` / `no` outlets move to `result`. |
| Gate | `in` · `control` | `out` | Passes the data arriving on `in` straight on while **open**, and stops it while **closed**. `control` takes a number: **1** opens it, **0** closes it (other values are ignored) — e.g. a Condition's `result`, or a message box holding `1` / `0`. While closed it holds the newest data back, and opening sends that on, so it doesn't matter whether the data or the control arrives first. Closed until the first control value unless *Start open* is on; right-click → *Open* / *Close*. Green border: open, red: closed. Anything passes — values, lists, info, even Timer signals (to switch an API's refresh on and off). |
| Dict | `in` · one per key | `out` | Keeps **named values** together, like a small table: `btc: 82,000 · eth: 3,100`. List the names in Settings → *Keys* (`btc, eth, sol`) and each gets its own input — whatever arrives on it is stored under that name. A dict arriving on `in` is merged in (same names replaced); a signal on `in` sends it as it is. Every change sends the whole dict out, so a Get after it can read any value. The box lists the keys (— until a value arrives) and everything it holds; what it holds is saved with the flow, so it survives a reload. Right-click → *Send* / *Clear*. |
| Message | `in` | `out` | Starts empty. **Anything arriving is shown and sent straight on** (lists and dicts shown as clickable rows; a row click sends that item). A signal arriving — or a click — sends the current content; an empty box passes the signal on as a blank token. Edit its text in the right panel. `$1` templates and `a, b` still work. |

### Card outlets

Send a plain signal (e.g. click a Timer wired in) to a card's `token` — no token needs to be selected — and it fetches and sends:

- **`info`** — the selected token's details (price, liquidity, volume…). With a blank token it's the market summary instead: coins tracked, total market cap, BTC/ETH dominance (CoinGecko); token count, tokens per chain, totals (DexScreener).
- **`list`** — every token in the chosen list (Settings → *List to fetch*), each as one item with its details: symbol, name, price, 24h change, market cap, volume, and id/address/chain.
- Token details are also sent whenever a token arrives (even the same one again), and on every refresh unless *Send info out on every update* is off.
- **`error`** (orange) — when a lookup fails (token not found, rate limit…) the card goes blank and sends `{ source, token, error }` here.

Each card shows its API state at the top right: **Fetching…** while a request is in flight, **Updated HH:MM:SS** after an answer, **Error** (reason on hover) after a failure. The wire into a card blinks as soon as a token is delivered; its output wires blink only when the API's answer arrives. Inputs always ask DexScreener fresh (never a cached copy); CoinGecko is asked again unless its answer is under a minute old — its free data doesn't change faster and asking more gets rate-limited — and then the badge shows when that answer was really fetched.

**Hover any outlet** to see what it carries and what it last sent. A card's outlet descriptions follow its settings (e.g. CoinGecko `list` reads "Top 250 coins by market cap" or "Trending…"), and below them **Last sent · time** previews the actual data: `list · 250 items — BTC, ETH, USDT, …`, or an info's first few items (`price: $82.37K`). "Nothing sent yet" means no data has come out of it. Clearing a card's token also clears its `data` preview.

Wire `list` into a message box to see one row per token; click a row to send that token on, e.g. into another card's `token` inlet.

### Adding a block

Create `src/blocks/cards/<name>/index.tsx` (or `objects/<name>`) exporting a `BlockDefinition` (see `src/blocks/types.ts`): `type`, `label`, `icon`, `category`, `defaultProps`, `settings`, `inlets` / `outlets`, a `receive(ctx, inlet, msg)` handler, and a `Render` component (which gets `ctx.send(outlet, msg)` to emit messages).

The inspector builds its form from `settings`, so a block doesn't need its own settings UI.

## Flows

Each flow is a file in `flows/` — `flow_1.json`, `flow_2.json`, … — holding its blocks and wires. Files are read and written by the dev server (`vite-plugin-flows.ts`), so flows need `npm run dev`.

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
