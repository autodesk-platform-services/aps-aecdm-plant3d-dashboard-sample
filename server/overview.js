const { graphql, GET_ELEMENTS_FULL } = require('./aecdm');
const { assess } = require('./quality');
const stores = require('./stores');
const { getClassHierarchy, indexByTableName, buildFilter, DCF_PATHS } = require('./schemas');
const {
  assessReconciliation,
  reconciliationPending,
} = require('./reconciliation');
const { AECDM_PAGE_LIMIT } = require('./config');
const { createLogger } = require('./logger');

const log = createLogger('app:overview');

/**
 * Counts the elements of an element group by class, for the overview chart.
 *
 * The only property fetched is "Table Names", which is the element's class
 * ancestry leaf-first. Reversing it gives a root-first path:
 *
 *   "Primary,PipeLines,Lines,EngineeringItems"
 *     -> ["EngineeringItems", "Lines", "PipeLines", "Primary"]
 *
 * A rollup at path ["EngineeringItems"] then buckets by index 1 ("Lines"),
 * which is exactly one level of drill-down. Verified against a real response:
 * 77/77 elements matched the ancestry in ProcessPower.dcf.
 *
 * NOTE on the two counts this returns:
 *   total   — every element the element group holds. AEC Data Model returns a
 *             row of EVERY PnP table as an element, so this includes the system
 *             tables the UI hides (PnPDrawings, PnPTagRegistry, PnPGeometry,
 *             PnPPicklistValues, PnPWorkHistory, …) plus the other branches.
 *   matched — elements under `path`. THIS is the number that lines up with the
 *             record count Plant 3D shows for e.g. Engineering Items.
 * They differ by a lot: 175 vs 1,938 on a real project is normal.
 */

const TABLE_NAMES_DEF = 'autodesk.plant3d.parameter:tableNames-1.0.0';

/** The two branches that hold real content; everything else is system metadata. */
const TOP_BRANCHES = ['EngineeringItems', 'NonEngineeringItems'];

/** Elements whose ancestry stops at the branch itself. */
const DIRECT = '(directly on this class)';

function throwIfAborted(signal) {
  if (signal && signal.aborted) {
    const error = new Error('Sync cancelled');
    error.cancelled = true;
    throw error;
  }
}

/** Class ancestry, root first. [] when the property is missing. */
function ancestry(element) {
  const results = (element.properties && element.properties.results) || [];
  const hit = results.find((p) => p.definition && p.definition.id === TABLE_NAMES_DEF);
  if (!hit || !hit.displayValue) return [];
  return String(hit.displayValue)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .reverse();
}

/**
 * Pages every element of the group WITH its full property bag.
 *
 * One pass feeds both charts: the overview only needs Table Names, but the
 * quality checks need every value, so fetching the lot once is half the
 * requests of two scoped passes. It is also ~8 KB per element rather than
 * ~150 bytes, so on a very large model consider raising AECDM_PAGE_LIMIT (max
 * 99) to cut the round trips.
 */
async function fetchElements(accessToken, elementGroupId, options = {}) {
  const { onProgress, signal, filterValue = null } = options;
  const filter = filterValue ? { query: buildFilter(filterValue) } : undefined;
  const all = [];
  let cursor = null;
  let pages = 0;

  if (filter) log(`narrowing server-side: ${filter.query}`);

  do {
    throwIfAborted(signal);

    const data = await graphql(accessToken, GET_ELEMENTS_FULL, {
      elementGroupId,
      filter,
      pagination: { limit: AECDM_PAGE_LIMIT, cursor },
    });

    const page = data.elementsByElementGroup;
    const results = page.results || [];
    all.push(...results);

    cursor = page.pagination ? page.pagination.cursor : null;
    pages += 1;
    log(`page ${pages}: ${results.length} element(s), ${all.length} total`);
    if (onProgress) onProgress({ phase: 'scan', pages, scanned: all.length, done: !cursor });
  } while (cursor);

  return { elements: all, pages, filterValue };
}

/** The .dcf is slow-changing metadata — read it once per kind per process. */
const classIndexByKind = new Map();

function dcfKindToPath(kind) {
  return kind === '3d' ? DCF_PATHS['3d'] : DCF_PATHS['2d'];
}

function getClassIndex(dcfKind = '2d') {
  if (!classIndexByKind.has(dcfKind)) {
    try {
      classIndexByKind.set(dcfKind, indexByTableName(getClassHierarchy(dcfKindToPath(dcfKind))));
    } catch (err) {
      log.error(`${dcfKind} class hierarchy unavailable: ${err.message}`);
      classIndexByKind.set(dcfKind, new Map());
    }
  }
  return classIndexByKind.get(dcfKind);
}

/**
 * Buckets ancestries one level below `path`.
 *
 * @param {string[][]} ancestries  root-first class paths
 * @param {string[]}   path        e.g. [] , ["EngineeringItems"], ["EngineeringItems","Equipment"]
 */
function rollup(ancestries, path = [], dcfKind = '2d') {
  const index = getClassIndex(dcfKind);
  const counts = new Map();

  let matched = 0;
  let unclassified = 0;

  for (const chain of ancestries) {
    if (!chain.length) {
      unclassified += 1;
      continue;
    }
    // Must sit under the requested path.
    if (path.some((segment, i) => chain[i] !== segment)) continue;

    matched += 1;
    const key = chain[path.length] || DIRECT;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const buckets = [...counts.entries()]
    .map(([tableName, count]) => {
      const node = tableName === DIRECT ? null : index.get(tableName);
      const children = node ? node.children.length : 0;
      return {
        tableName,
        // .dcf display name when available, else the raw class name.
        label: node ? node.displayName || node.tableName : tableName,
        count,
        percent: matched ? Number(((count / matched) * 100).toFixed(1)) : 0,
        // Whether clicking this bucket can drill any further.
        drillable: children > 0 && tableName !== DIRECT,
      };
    })
    .sort((a, b) => b.count - a.count);

  return { buckets, matched, unclassified, total: ancestries.length, path };
}

/**
 * The AEC Data Model filter that narrows a fetch to `path`, or null to scan
 * everything.
 *
 * The filter comes from the DEEPEST class in the path, because that is the
 * actual scope: syncing EngineeringItems > Nozzles must send
 * `contains='Nozzles,EngineeringItems'`, not the branch's filter.
 *
 * `=contains=` is a plain substring test, so it is only used where no other
 * class chain contains this one (`filterSafe`). 'EngineeringItems' fails that
 * test — it is a substring of 'NonEngineeringItems' — so the branch itself
 * still scans and groups in memory. Its five children, and every child of
 * NonEngineeringItems, are all safe.
 */
function filterForPath(path, dcfKind = '2d') {
  if (!path.length) return null;
  const node = getClassIndex(dcfKind).get(path[path.length - 1]);
  if (!node || !node.filterSafe || !node.filterValue) return null;
  return node.filterValue;
}

/**
 * Elements from the last sync, per element group.
 *
 * One fetch, two charts: the overview regroups the cached ancestries and the
 * quality card assesses the cached property values. Both drill-downs are then
 * in-memory, which is what makes clicking a bar instant.
 */
const cache = new Map(); // `${elementGroupId}|${path}` -> { elements, ancestries, … }
const cacheKey = (elementGroupId, path) => `${elementGroupId}|${path.join(',')}`;

/**
 * The cached fetch that covers `path`.
 *
 * A sync stores its own scope, so a drill-down has to look upwards: syncing
 * Nozzles then drilling into one of its classes must reuse the Nozzles fetch.
 * Longest prefix wins, so the narrowest fetch that still covers the request is
 * the one used.
 */
function findEntry(elementGroupId, path) {
  for (let i = path.length; i >= 0; i -= 1) {
    const entry = cache.get(cacheKey(elementGroupId, path.slice(0, i)));
    if (entry) return entry;
  }
  return null;
}

/** Elements whose ancestry, root-first, starts with `path`. */
const inScope = (entry, path) =>
  entry.elements.filter((_, i) => path.every((seg, j) => entry.ancestries[i][j] === seg));

function pathIsPrefix(prefix, full) {
  if (prefix.length > full.length) return false;
  return prefix.every((seg, i) => full[i] === seg);
}

/** True when two sync scopes overlap (one is under the other). */
function pathsOverlap(a, b) {
  return pathIsPrefix(a, b) || pathIsPrefix(b, a);
}

/**
 * Peer-side elements for reconciliation at `path`.
 *
 * Unlike findEntry, this also finds *deeper* peer syncs whose scope sits under
 * `path` — e.g. P&ID synced at Engineering Items while 3D synced only
 * Equipment / Fasteners / PipeRunComponent.
 */
function peerElementsAtScope(peerGroupId, path) {
  const merged = new Map();

  for (const [key, peerEntry] of cache.entries()) {
    if (!key.startsWith(`${peerGroupId}|`)) continue;
    const entryPath = peerEntry.path || [];
    if (!pathsOverlap(entryPath, path)) continue;
    for (const element of inScope(peerEntry, path)) {
      if (element.id) merged.set(element.id, element);
    }
  }

  return merged.size ? [...merged.values()] : null;
}

/**
 * Full sync: fetch every element once, cache it, and return BOTH the class
 * rollup and the quality assessment for `path`.
 */
async function syncOverview(accessToken, elementGroupId, options = {}) {
  const {
    path = [],
    onProgress,
    onOverview,
    signal,
    dcfKind = '2d',
    reconcileWithElementGroupId = null,
  } = options;
  log(
    `sync ${elementGroupId} (${dcfKind}) at path [${path.join(' > ') || 'root'}]` +
      (reconcileWithElementGroupId ? ` · reconcile with ${reconcileWithElementGroupId}` : ''),
  );

  const filterValue = filterForPath(path, dcfKind);
  const { elements, pages } = await fetchElements(accessToken, elementGroupId, {
    onProgress,
    signal,
    filterValue,
  });
  const ancestries = elements.map(ancestry);
  const entry = {
    elements,
    ancestries,
    pages,
    filterValue,
    syncedAt: new Date().toISOString(),
    dcfKind,
    reconcileWithElementGroupId,
  };
  entry.path = path;
  cache.set(cacheKey(elementGroupId, path), entry);

  // A branch sync also feeds the engineering-items table, so keep its elements
  // under their own name.
  //
  // Store the IN-SCOPE subset, never the raw fetch: EngineeringItems cannot be
  // narrowed server-side, so `elements` is the whole element group — mostly
  // Plant 3D system tables. Only a full branch sync qualifies; a narrower scope
  // like Nozzles would give a partial table.
  const STORE_FOR_BRANCH = {
    EngineeringItems: stores.ENGINEERING_ITEMS,
    NonEngineeringItems: stores.NON_ENGINEERING_ITEMS,
  };
  if (path.length === 1 && STORE_FOR_BRANCH[path[0]]) {
    const scoped = inScope(entry, path);
    stores.put(elementGroupId, STORE_FOR_BRANCH[path[0]], scoped, {
      path,
      pages,
      filterValue,
      fetched: elements.length,
      stored: scoped.length,
    });
    log(`${STORE_FOR_BRANCH[path[0]]}: kept ${scoped.length} of ${elements.length} fetched`);
  }

  // Grouping is cheap, so the overview goes out first and the UI can draw it
  // while the quality pass — which touches every property of every element —
  // still has work to do.
  const overview = {
    ...rollup(ancestries, path, dcfKind),
    pages,
    syncedAt: entry.syncedAt,
    cached: false,
    // When the fetch was narrowed, `total` is the filtered count — not the
    // whole data set — so the UI must not present it as such.
    filtered: filterValue,
    dcfKind,
  };
  log(
    `${overview.total} element(s) over ${pages} page(s); ` +
      `${overview.matched} under [${path.join(' > ') || 'root'}], ` +
      `${overview.buckets.length} bucket(s)`,
  );
  if (onOverview) onOverview(overview);

  if (onProgress) onProgress({ phase: 'assess', scanned: elements.length });
  // Strip the issue arrays: they are served on demand by issuesFor, and on a
  // large model they would dwarf the summary payload.
  const { _issues, ...quality } = assessScope(entry, path, {
    reconcileWithElementGroupId,
  });

  return { overview, quality };
}

function peerKind(dcfKind) {
  return dcfKind === '3d' ? '2d' : '3d';
}

/**
 * P&ID ↔ 3D reconciliation for the same class scope, when both sides are cached.
 */
function reconciliationFor(entry, path, reconcileWithElementGroupId) {
  if (!reconcileWithElementGroupId) {
    return {
      metric: reconciliationPending('Open the paired P&ID / 3D data set from the same project.'),
      issues: [],
    };
  }

  const peerElements = peerElementsAtScope(reconcileWithElementGroupId, path);
  if (!peerElements) {
    const peerLabel = peerKind(entry.dcfKind || '2d') === '2d' ? 'P&ID' : '3D';
    return {
      metric: reconciliationPending(
        `Sync overlapping content on the ${peerLabel} data set (same class or its parent branch).`,
      ),
      issues: [],
    };
  }

  const thisKind = entry.dcfKind || '2d';
  const thisElements = inScope(entry, path);
  const pidElements = thisKind === '2d' ? thisElements : peerElements;
  const pipingElements = thisKind === '3d' ? thisElements : peerElements;

  return assessReconciliation(pidElements, pipingElements);
}

/** Quality for one scope, computed from the cached elements — no APS traffic. */
function assessScope(entry, path, options = {}) {
  const reconcileWith =
    options.reconcileWithElementGroupId !== undefined
      ? options.reconcileWithElementGroupId
      : entry.reconcileWithElementGroupId;

  const scoped = inScope(entry, path);
  const result = assess(scoped, { dcfPath: dcfKindToPath(entry.dcfKind || '2d') });
  const { issues, ...summary } = result;

  const { metric: reconciliationMetric, issues: reconciliationIssues } = reconciliationFor(
    entry,
    path,
    reconcileWith,
  );

  return {
    ...summary,
    metrics: [...summary.metrics, reconciliationMetric],
    fetched: entry.elements.length,
    pages: entry.pages,
    path,
    syncedAt: entry.syncedAt,
    dcfKind: entry.dcfKind || '2d',
    _issues: {
      ...issues,
      reconciliation: reconciliationIssues,
    },
  };
}

/** Regroup an already-synced element group. Returns null when not synced yet. */
function rollupCached(elementGroupId, path = []) {
  const entry = findEntry(elementGroupId, path);
  if (!entry) return null;
  return {
    ...rollup(entry.ancestries, path, entry.dcfKind || '2d'),
    pages: entry.pages,
    syncedAt: entry.syncedAt,
    cached: true,
    filtered: entry.filterValue,
    dcfKind: entry.dcfKind || '2d',
  };
}

/** Quality summary for a scope, from cache. Null when not synced. */
function qualityCached(elementGroupId, path = []) {
  const entry = findEntry(elementGroupId, path);
  if (!entry) return null;
  const { _issues, ...summary } = assessScope(entry, path);
  return summary;
}

/** The element rows behind one quality metric. Null when not synced. */
function issuesFor(elementGroupId, path = [], metric = 'completeness') {
  const entry = findEntry(elementGroupId, path);
  if (!entry) return null;
  const scoped = assessScope(entry, path);
  return {
    metric,
    rows: scoped._issues[metric] || [],
    syncedAt: entry.syncedAt,
    implemented: (scoped.metrics.find((m) => m.key === metric) || {}).implemented === true,
  };
}

const isSynced = (elementGroupId, path = []) => findEntry(elementGroupId, path) !== null;

module.exports = {
  syncOverview,
  filterForPath,
  rollupCached,
  qualityCached,
  issuesFor,
  isSynced,
  fetchElements,
  rollup,
  ancestry,
  TOP_BRANCHES,
  DIRECT,
};
