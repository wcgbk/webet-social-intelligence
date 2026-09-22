# Omega shadow dry-run (9:05 ET)

Scheduled isolated generate. The live Omega card is not written.

## Schedule

`trigger-omega-shadow` runs at **13:05 UTC** (`5 13 * * *`), about **9:05am ET during EDT**. It POSTs `generate-picks-omega-background` with:

```json
{ "shadow": true, "scheduled": true, "force": true, "skipNarrate": true }
```

The same minute as the NFL trigger is fine. The jobs do not share pick keys.

`generateOmegaVnext({ shadow: true })` is the same pipeline as the 9:30 public generate, with narration skipped and storage redirected.

## Isolation

The blob store is still `edge-picks-omega`. Shadow mode writes prefixed keys only:

| Key | What |
|-----|------|
| `omega-shadow/picks-{YYYY-MM-DD}` | Shadow card for that ET date |
| `omega-shadow/pm-observer/{YYYY-MM-DD}` | PM observer artifact for the shadow run, if the observer call succeeds |

Shadow mode does **not** write:

- `picks-{date}` (live card)
- `latest-date`
- `picks-dates`
- `picks-sim-{date}`

`OVERWRITE_GUARD` does not run on this path. Live keys are not opened for write. `get-picks-omega` reads `latest-date`, `picks-dates`, and `picks-{date}` only, so a shadow card cannot become the public `/omega` card.

There is no public unlock. Verify (`verify-picks-omega`) is not invoked.

Empty cards are allowed. The run does not force-fill leans. PM observer output stays under the shadow prefix and is not mixed into selection, grades, units, or gates.

A capture-health retry may still write `omega-line-snap-*` / `omega-line-path/{date}` (real Odds polls only). Those are the shared morning line path, not the published card.

## Capture health

Zero usable morning snaps after one Odds retry fails the run with `CAPTURE_HEALTH`. That error does not publish a live card and does not update `latest-date`.

## What this is not

Not a replacement for `trigger-picks-omega` at 9:30 ET. Not a TSP, Kalshi, or Polymarket input to Omega grades.
