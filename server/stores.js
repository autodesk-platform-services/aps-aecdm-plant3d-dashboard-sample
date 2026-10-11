const { createLogger } = require('./logger');

const log = createLogger('app:stores');

/**
 * Named, in-process stores of fetched elements, per element group.
 *
 *   engineering_items_overview_data      — Engineering Items only, from that branch sync
 *   non_engineering_items_overview_data  — Non Engineering Items only
 *   relationship_data                    — every relationship element, all types
 *
 * The two item stores hold ONLY elements of their branch. A branch sync fetches
 * the whole element group (the EngineeringItems filter over-matches, so it
 * cannot be narrowed server-side), and most of that is Plant 3D system tables —
 * PnPTagRegistry, PnPDrawings, PnPGeometry. Storing the raw fetch would put
 * ~1,700 metadata rows into a table meant to list 175 engineering items.
 *
 * These exist so one fetch can serve several views: the overview and quality
 * charts, the engineering-items table, and the pair lookup all read from here
 * rather than going back to the API.
 *
 * In-process means a restart clears them; that is why every consumer reports a
 * clear "not synced yet" rather than an empty result.
 */

const ENGINEERING_ITEMS = 'engineering_items_overview_data';
const NON_ENGINEERING_ITEMS = 'non_engineering_items_overview_data';
const RELATIONSHIPS = 'relationship_data';

const stores = new Map(); // `${elementGroupId}|${name}` -> { data, meta, storedAt }

const key = (elementGroupId, name) => `${elementGroupId}|${name}`;

function put(elementGroupId, name, data, meta = {}) {
  stores.set(key(elementGroupId, name), {
    data,
    meta,
    storedAt: new Date().toISOString(),
  });
  log(`${name}: stored ${Array.isArray(data) ? data.length : 1} item(s) for ${elementGroupId}`);
}

/** @returns {{data, meta, storedAt}|null} */
const get = (elementGroupId, name) => stores.get(key(elementGroupId, name)) || null;

const has = (elementGroupId, name) => stores.has(key(elementGroupId, name));

const clear = (elementGroupId, name) => stores.delete(key(elementGroupId, name));

module.exports = {
  put,
  get,
  has,
  clear,
  ENGINEERING_ITEMS,
  NON_ENGINEERING_ITEMS,
  RELATIONSHIPS,
};
