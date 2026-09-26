# Short links: `webetsocial.com/r/<id>`

Every link we post or share (X posts, X bio, replies, DMs, Betty's scripts, emails) should be a short link.
Each one redirects to a page on the site with UTM tags attached, so Google Analytics can tell which
post, source and campaign each visitor came from.

## Link format

```
https://webetsocial.com/r/<id>
```

- `<id>` is a random 6-character code (e.g. `6dzbjs`, no easily confused characters like l/1/0/o),
  or a readable id you choose (e.g. `betty-x`).
- Visiting it returns a 302 redirect to the destination with these parameters added:

| Parameter      | Value                                                                  |
|----------------|------------------------------------------------------------------------|
| `utm_source`   | default `x`, can be overridden per link                                |
| `utm_medium`   | default `social`, can be overridden per link                           |
| `utm_campaign` | default `webet`, can be overridden per link                            |
| `utm_content`  | defaults to the link id, can be overridden (e.g. `post_a`, `bio`)       |
| `utm_id`       | always the link id, so every link is its own row in GA4                |

Example: `/r/betty-x` redirects to
`/grokbot?utm_source=x&utm_medium=social&utm_campaign=betty&utm_content=betty-x&utm_id=betty-x`.

Unknown ids redirect to the homepage rather than a 404. Destinations ending in `#fragment` keep it.

## How it works

- `links/links.json` is the registry. It holds the defaults and one entry per link (id, destination, any UTM overrides,
  a note and the creation time).
- `scripts/new-link.js` adds an entry and regenerates the `/r/` block at the bottom of `_redirects`.
  Netlify serves those rules as plain 302s at the edge. There's no function or database, so nothing can break at runtime.
- The block sits between the `# >>> SHORT LINKS` and `# <<< SHORT LINKS END` markers. Don't edit it by hand;
  edit `links/links.json` and run `node scripts/new-link.js --rebuild`.
- Links only go live after a push to `main` (Netlify deploys in about a minute). Watch the deploy blackout windows in `PRODUCT-STATE.md`.

## Creating a link

From the repo root:

```bash
# Random id, all default UTMs (x / social / webet)
node scripts/new-link.js --to /grokbot --note "X post: Betty launch"

# Override any UTM
node scripts/new-link.js --to /daily-omega --campaign omega --content sep26_card

# Readable id
node scripts/new-link.js --id bio --to /grokbot --campaign betty --content bio --note "X bio link"

# Create, commit and push in one go
node scripts/new-link.js --to /grokbot --campaign betty --push

# See every link
node scripts/new-link.js --list
```

The script prints the short URL and where it goes. Destinations should be pages on webetsocial.com (`/path`).
Full `https://` destinations are allowed, but GA can only measure visits that land on our own pages.

Rule of thumb for X: use one new link per post (the default random id), with `--campaign` set to the product or push
(`betty`, `omega`, `pvp`) and `--content` for the variant if you're testing copy. For the X bio, use one fixed link (`--id bio`).

## Reading the results in Google Analytics (property G-848D47V084)

- **Reports, then Acquisition, then Traffic acquisition**: switch the primary dimension to *Session source / medium* or
  *Session campaign* to see sessions, users and engagement from each source and campaign.
- **Per link**: add the *Session manual ad content* dimension (from `utm_content`) or, in Explore, *Session manual campaign ID*
  (from `utm_id`). Each short link id appears as its own row with users, sessions and views.
- **Unique visitors** means *Users* (or *Active users*). *Sessions* is the closest measure of clicks that reached the site.
- The redirect itself isn't logged (Netlify Analytics is off on this site), so a click only counts once the page loads GA.
  Visitors who block analytics or bounce before the page loads won't show up.

## Related link helpers (older, still working)

- `/go/{source}/{campaign}/{content}[/path]`: UTMs written into the URL itself (`netlify/functions/go-redirect.js`).
- `/b/grokbot`, `/b/share`, `/b/omega`: fixed links used inside Betty's bot scripts.
- `/s/betty`: the share button on /grokbot.

For new posts and shares, use `/r/`.
