const { graphql, GET_ELEMENTS_FULL } = require('./aecdm');
const { getRelationshipTypes, relationshipRoles } = require('./schemas');
const { AECDM_PAGE_LIMIT } = require('./config');
const stores = require('./stores');
const { createLogger } = require('./logger');

const log = createLogger('app:relationships');

/**
 * Relationship elements, and the pairing they encode.
 *
 * A relationship element's class is the relationship type name, and it carries
 * one property per endpoint role whose displayValue is the related element's
 * PnPID:
 *
 *   LineOffPageConnector  ->  Line: "483",  OffPageConnector: "627"
 *
 * So OffPageConnector 627 is paired with element 483.
 */

const CLASS_NAME_DEF = 'autodesk.plant3d.parameter:pnpClassName-1.0.0';
const PNP_ID_DEF = 'autodesk.plant3d.parameter:pnpId-1.0.0';
const TAG_DEF = 'autodesk.plant3d.parameter:tag-1.0.0';
const AREA_DEF = 'autodesk.plant3d.parameter:area-1.0.0';
const STATUS_DEF = 'autodesk.plant3d.parameter:status-1.0.0';
const DESCRIPTION_DEF = 'autodesk.plant3d.parameter:description-1.0.0';
const SPEC_DEF = 'autodesk.plant3d.parameter:spec-1.0.0';
const TABLE_NAMES_DEF = 'autodesk.plant3d.parameter:tableNames-1.0.0';

const propsOf = (element) => (element.properties && element.properties.results) || [];

const isBlank = (v) => v === null || v === undefined || String(v).trim() === '';

function readProp(element, definitionId) {
  const hit = propsOf(element).find((p) => p.definition && p.definition.id === definitionId);
  return hit && !isBlank(hit.displayValue) ? String(hit.displayValue).trim() : null;
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) {
    const error = new Error('Relationship sync cancelled');
    error.cancelled = true;
    throw error;
  }
}

/** Pages every element of one relationship type. */
async function fetchType(accessToken, elementGroupId, type, { onProgress, signal } = {}) {
  const elements = [];
  let cursor = null;
  let pages = 0;

  do {
    throwIfAborted(signal);

    const data = await graphql(accessToken, GET_ELEMENTS_FULL, {
      elementGroupId,
      filter: { query: type.filter },
      pagination: { limit: AECDM_PAGE_LIMIT, cursor },
    });

    const page = data.elementsByElementGroup;
    elements.push(...(page.results || []));
    cursor = page.pagination ? page.pagination.cursor : null;
    pages += 1;
    if (onProgress) onProgress({ typeName: type.typeName, fetched: elements.length, pages });
  } while (cursor);

  return { elements, pages };
}

/**
 * Fetches every relationship type in turn and stores the lot under
 * `relationship_data`.
 *
 * Only the 15 types with a physical table are queried; the other four are
 * abstract and can hold no elements, so asking for them would just burn
 * requests against the rate limit.
 */
async function syncRelationships(accessToken, elementGroupId, options = {}) {
  const { onProgress, signal } = options;
  const types = getRelationshipTypes().filter((t) => t.hasTable);

  const all = [];
  const perType = [];
  let pages = 0;

  for (let i = 0; i < types.length; i += 1) {
    const type = types[i];
    throwIfAborted(signal);

    if (onProgress) {
      onProgress({
        phase: 'scan',
        typeName: type.typeName,
        typeIndex: i + 1,
        typeCount: types.length,
        fetched: all.length,
      });
    }

    const { elements, pages: typePages } = await fetchType(accessToken, elementGroupId, type, {
      signal,
      onProgress: (p) =>
        onProgress &&
        onProgress({
          phase: 'scan',
          typeName: type.typeName,
          typeIndex: i + 1,
          typeCount: types.length,
          fetched: all.length + p.fetched,
        }),
    });

    // Tag each element with its type so pairing knows the roles to look at.
    for (const element of elements) all.push({ element, typeName: type.typeName });
    perType.push({ typeName: type.typeName, count: elements.length, endpoints: type.endpoints });
    pages += typePages;
    log(`${type.typeName}: ${elements.length} element(s) over ${typePages} page(s)`);
  }

  stores.put(elementGroupId, stores.RELATIONSHIPS, all, { perType, pages, types: types.length });
  log(`relationship_data: ${all.length} element(s) across ${types.length} type(s)`);

  return {
    total: all.length,
    pages,
    types: perType.sort((a, b) => b.count - a.count),
    storedAt: stores.get(elementGroupId, stores.RELATIONSHIPS).storedAt,
  };
}

/* ---------- engineering items table ---------- */

/**
 * Class ancestry root-first, e.g. ['EngineeringItems','Equipment','Tanks','Vessel'].
 * The schematic picks a symbol from this, so it does not have to guess from the
 * class name.
 */
function ancestryRootFirst(element) {
  const raw = readProp(element, TABLE_NAMES_DEF);
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .reverse();
}

/** One row of the engineering-items table. */
const toRow = (element) => ({
  elementId: element.id || null,
  pnpId: readProp(element, PNP_ID_DEF),
  className: readProp(element, CLASS_NAME_DEF),
  tag: readProp(element, TAG_DEF),
  area: readProp(element, AREA_DEF),
  status: readProp(element, STATUS_DEF),
  description: readProp(element, DESCRIPTION_DEF),
  spec: readProp(element, SPEC_DEF),
  ancestry: ancestryRootFirst(element),
});

/**
 * A page of engineering items from `engineering_items_overview_data`.
 * @returns {object|null} null when Engineering Items has not been synced
 */
function engineeringItems(elementGroupId, { page = 1, size = 50 } = {}) {
  const entry = stores.get(elementGroupId, stores.ENGINEERING_ITEMS);
  if (!entry) return null;

  const rows = entry.data.map(toRow);
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const current = Math.min(Math.max(1, page), pages);
  const start = (current - 1) * size;

  return {
    rows: rows.slice(start, start + size),
    page: current,
    size,
    pages,
    total: rows.length,
    storedAt: entry.storedAt,
  };
}

/* ---------- pairing ---------- */

/**
 * The elements paired with `pnpId`, via `relationship_data`.
 *
 * Matching is on PnPID, not class name. The endpoint roles are not class names
 * — `LineOffPageConnector.Line` points at an element whose own class is e.g.
 * `Primary` — so a class-name match would silently miss every line. PnPID is
 * the PnPBase primary key and therefore unique across the project, which makes
 * it both simpler and correct.
 *
 * @returns {object|null} null when relationships have not been synced
 */
function pairsFor(elementGroupId, pnpId) {
  const relEntry = stores.get(elementGroupId, stores.RELATIONSHIPS);
  if (!relEntry) return null;

  const target = String(pnpId).trim();
  const roles = relationshipRoles();

  // Index items by PnPID so pairs can be named. Both branches are consulted:
  // many relationships cross the boundary — LineOffPageConnector pairs a line
  // (engineering) with an off-page connector (non-engineering) — so using only
  // the engineering store would leave half the pairs unnamed.
  const itemsEntry = stores.get(elementGroupId, stores.ENGINEERING_ITEMS);
  const nonEngEntry = stores.get(elementGroupId, stores.NON_ENGINEERING_ITEMS);
  const byPnpId = new Map();
  for (const entry of [itemsEntry, nonEngEntry]) {
    if (!entry) continue;
    for (const element of entry.data) {
      const id = readProp(element, PNP_ID_DEF);
      if (id) byPnpId.set(id, element);
    }
  }

  const pairs = [];
  const seen = new Set();

  for (const { element, typeName } of relEntry.data) {
    // Endpoint properties of this relationship element: role -> PnPID.
    const endpoints = propsOf(element)
      .filter((p) => roles.has(p.name) && !isBlank(p.displayValue))
      .map((p) => ({ role: p.name, pnpId: String(p.displayValue).trim() }));

    const mine = endpoints.find((e) => e.pnpId === target);
    if (!mine) continue;

    for (const other of endpoints) {
      if (other === mine || other.pnpId === target) continue;
      const dedupe = `${typeName}|${other.role}|${other.pnpId}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);

      const paired = byPnpId.get(other.pnpId);
      pairs.push({
        pnpId: other.pnpId,
        // Falls back to the endpoint role when the element is in neither item
        // store (that branch has not been synced).
        className: paired ? readProp(paired, CLASS_NAME_DEF) : null,
        tag: paired ? readProp(paired, TAG_DEF) : null,
        spec: paired ? readProp(paired, SPEC_DEF) : null,
        ancestry: paired ? ancestryRootFirst(paired) : [],
        role: other.role,
        via: typeName,
        resolved: Boolean(paired),
      });
    }
  }

  return {
    pnpId: target,
    pairs: pairs.sort((a, b) => a.via.localeCompare(b.via) || a.pnpId.localeCompare(b.pnpId)),
    itemsAvailable: Boolean(itemsEntry),
    nonEngineeringAvailable: Boolean(nonEngEntry),
    storedAt: relEntry.storedAt,
  };
}

module.exports = { syncRelationships, engineeringItems, pairsFor, toRow };
