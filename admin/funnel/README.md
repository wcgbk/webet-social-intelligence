# Admin Funnel Report

`admin/funnel/` is a role-gated internal page (noindex) that renders daily funnel-event
counts and step-to-step conversion for the last 14 days. It fetches
`/.netlify/functions/funnel-report`, which validates the `wbai_session` cookie and gates on
an admin allowlist.

## Seed the admin allowlist (required — page returns 403 until you do)

The allowlist lives in the **`wbai-users`** blob store under key **`admin-allowlist`** as a
JSON array of userIds. If the blob is missing it is treated as empty and **everyone gets 403**.
Seed it with your X user id (the numeric id behind your @handle — same value stored as
`user_id` on your session):

```js
// one-off, run with NETLIFY_TOKEN set in the environment
const { getStore } = require('@netlify/blobs');
const users = getStore({
  name: 'wbai-users',
  siteID: '87d7bcd9-e95a-479c-bc44-6432a2ffc606',
  token: process.env.NETLIFY_TOKEN,
});
await users.setJSON('admin-allowlist', ['YOUR_X_USER_ID']); // add more ids to grant access
```

Add or remove ids in that array to manage admin access. `funnel-events` is written via the
@netlify/blobs **SDK** (not the legacy REST blob API) — `funnel-report.js` reads it the same
way; a REST listing of that store returns empty.
