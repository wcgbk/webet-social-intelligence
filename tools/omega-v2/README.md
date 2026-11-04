# Pipeline v2 replays

`replay.js` walks the sizing-v2 derived card. Those rows carry a price and no book. A row is priced only after a stored DraftKings or Hard Rock quote is joined on the same game, market, side, and line.

The join reads offline files only:

- odds-master boards through `loadMasterBoard`, the same cached-board reader `dryrun-card.js` uses, pointed at the local blob cache
- morning line snaps in the stored replay inputs
- `/workspace/stakeaudit/card-*.json` when the stored book is DraftKings or Hard Rock
- `/workspace/urgent1103` odds snapshots

A stored price from any other book stays unused. Inside one snapshot the higher American number is kept. Prices from different snapshots are not mixed.

When a candidate row has no stored quote, the replay header says the coverage is short of the full pool. The primary 30-day replay used for ship decisions is `tools/omega-v2/replay-bp1104.js`. If the offline files contain no DraftKings or Hard Rock quote for the pool, `replay.js` prints `no stored DK/HR quotes` instead of a silent zero.
