const { DM_BASE_URL } = require('./config');
const { createLogger } = require('./logger');

const log = createLogger('app:dm');

/**
 * Data Management API GET. The Plant 3D scan no longer needs this — ElementGroup
 * carries parentFolder.parentFolder — so it now only backs /api/debug/dm.
 */
async function dmGet(accessToken, path) {
  const done = log.time(`GET ${path}`);
  const res = await fetch(`${DM_BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  done(`← ${res.status}`);

  if (!res.ok) {
    const error = new Error(`Data Management API returned ${res.status} for ${path}`);
    error.status = res.status;
    error.details = await res.text().catch(() => undefined);
    log.error(`GET ${path} failed`, error.details);
    throw error;
  }
  return res.json();
}

module.exports = { dmGet };
