# Agentics dashboard

Public display page: [https://webetsocial.com/agentics](https://webetsocial.com/agentics)

Read-only function: `GET /.netlify/functions/agentics-ledger` (also `/api/agentics-ledger`).

The function reads one Netlify Blobs object and returns it:

| | |
|---|---|
| Store | `agentics` |
| Key | `omega-shadow/latest.json` |
| Methods | GET only. Anything else is `405`. |
| Cache | `Cache-Control: public, max-age=60` |
| Missing key | `200` with an empty ledger (`empty: true`, zero record, empty picks and ledger). It does not create the key. |

The page is display only. It does not place orders and it does not change Omega picks.

## Schema

- Contract: `docs/agentics-dashboard-schema.json`
- Filled example: `docs/agentics-dashboard-sample.json` (`sample: true`)

`price` is a Polymarket probability from 0 to 1 (0.57 displays as 57¢). `stake` and `fee` are USD. `stake` is the position cost before the fee. Settled `pl` is USD after fees. `roiPct` is percent points (`4.2` means +4.2%), equal to `100 * pl / staked` on settled positions. `clvCents` is `(closePrice - price) * 100` versus the Polymarket close. Drawdown limits are 5% daily, 7.5% weekly, and 12% total. The review gate is 14 days and 20 trades.

## Publish

From a checkout linked to the site (`netlify link`), write the ledger with the Netlify CLI.

Syntax checked against the CLI reference for `blobs:set` ([docs/commands/blobs.md](https://github.com/netlify/cli/blob/main/docs/commands/blobs.md)): arguments are `store`, `key`, and an optional inline `value`. The `--input` flag reads the value from a file. The documented example is `netlify blobs:set my-store my-key --input ./some-file.txt`.

```bash
netlify blobs:set agentics omega-shadow/latest.json --input <file>
```

`<file>` is JSON matching the schema. To smoke-test the page with the checked-in example:

```bash
netlify blobs:set agentics omega-shadow/latest.json --input docs/agentics-dashboard-sample.json
```

Read it back:

```bash
netlify blobs:get agentics omega-shadow/latest.json
```

Deploy the function and the page with `deploy.sh`. This repo does not publish the blob during deploy.
