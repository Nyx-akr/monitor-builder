# Dex Builder

A no-code, Max/MSP-style patcher for crypto pages: drop cards and objects on a canvas, wire them together, and data flows along the wires. Live data from [DexScreener](https://docs.dexscreener.com/api/reference) and [CoinGecko](https://docs.coingecko.com).

```bash
npm install
npm run dev
```

## How it works

- **Blocks** (left) — drag onto the canvas, or click to add.
- **Canvas** (center) — drag blocks anywhere; scroll to zoom, drag empty space (or hold Space) to pan; hover a block for duplicate / delete.
- **Settings** (right) — edit the selected block; the **Ports** section lists its wires (✕ disconnects).
- **Flow selector** (top right) — switch flows or create a new blank one. Every change autosaves.
- **Preview** — hides the editor chrome.

## Wires are data flow

Like patch cords in Max/MSP, wires carry real messages from an **outlet** (bottom edge) to an **inlet** (top edge). What's connected is what happens.

- **Connect:** drag from an outlet to an inlet (or the other way).
- **Disconnect:** click a wire and press Delete, or use ✕ in the Ports panel.
- One outlet can feed many inlets; a message is delivered along every wire leaving the outlet.
- Feedback loops stop after 64 hops (a "stack overflow" warning in the console).

## Blocks

Blocks live in folders and are discovered automatically — add a folder to add a block, delete it to remove one.

```
src/blocks/
  cards/
    tokenCard/   Token Card (DexScreener)
    coinCard/    Coin Card (CoinGecko)
  objects/
    message/     Message box
```

| Block | Inlets | Outlets | Notes |
| --- | --- | --- | --- |
| Token Card | `token` | — | Address or symbol (e.g. `PEPE`) shows its most liquid pair on any chain; `solana BONK` pins a chain. |
| Coin Card | `token` | — | CoinGecko id, symbol or name (e.g. `btc`, `pepe`). Resolved from the saved Top 250 first, so common tokens cost no request. |
| Message | `in` | `out` | Click sends its text; double-click edits. `a, b` sends two messages. Inlet: `bang` outputs, `set foo` replaces the text, anything else fills `$1` and outputs. |

### Adding a block

Create `src/blocks/cards/<name>/index.tsx` (or `objects/<name>`) exporting a `BlockDefinition` (see `src/blocks/types.ts`): `type`, `label`, `icon`, `category`, `defaultProps`, `settings`, `inlets` / `outlets`, a `receive(ctx, inlet, msg)` handler, and a `Render` component (which gets `ctx.send(outlet, msg)` to emit messages).

The inspector builds its form from `settings`, so a block doesn't need its own settings UI.

## Flows

Each flow is a file in `flows/` — `flow_1.json`, `flow_2.json`, … — holding its blocks and wires. Files are read and written by the dev server (`vite-plugin-flows.ts`), so flows need `npm run dev`.

- Saves carry a revision number; if the file changed elsewhere (e.g. a second tab), the save is refused rather than overwriting it.
- Pan/zoom isn't part of the flow — each browser remembers its own view per flow.

## CoinGecko API key (optional)

The keyless tier allows only a few requests per minute, and retrying while blocked extends the block. Dex Builder spaces CoinGecko requests out, pauses them all after a rate-limit response, and caches results. A free [Demo key](https://www.coingecko.com/en/api/pricing) raises the limit to 30/min:

```bash
cp .env.example .env.local   # then paste your key into VITE_COINGECKO_KEY
```
