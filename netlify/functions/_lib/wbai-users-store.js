// Shared Netlify Blobs accessor for wbai-users (auth + admin).
async function getWbaiUsersStore() {
  const { getStore } = await import('@netlify/blobs');
  const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID || '87d7bcd9-e95a-479c-bc44-6432a2ffc606';
  const token = process.env.NETLIFY_TOKEN || process.env.NETLIFY_AUTH_TOKEN;
  if (token) {
    return getStore({ name: 'wbai-users', siteID, token });
  }
  // Ambient credentials inside Netlify Functions runtime
  return getStore('wbai-users');
}

module.exports = { getWbaiUsersStore };
