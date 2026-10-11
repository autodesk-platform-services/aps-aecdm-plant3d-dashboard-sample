const fs = require('fs');
const path = require('path');
const { query } = require('./sqliteDriver');

/**
 * Class hierarchy of the P&ID tables defined in ProcessPower.dcf — the 2D table
 * schema of a Plant 3D project.
 *
 *   const { getClassHierarchy } = require('./server/schemas');
 *   const tree = getClassHierarchy();                          // bundled ProcessPower.dcf
 *   const tree = getClassHierarchy('/path/to/ProcessPower.dcf');
 *
 * Both .dcf files in a Plant 3D project folder share this schema, so the same
 * call reads Piping.dcf (the 3D side) as well. Path resolution order:
 * argument → PROCESSPOWER_DCF → the ProcessPower.dcf next to this module.
 */

const SQL_PATH = path.join(__dirname, 'classHierarchy.sql');

/** "TRUE"/"FALSE" as stored in PnPTables.Abstract. */
const toBool = (value) => String(value).trim().toUpperCase() === 'TRUE';

/** Some DisplayName values carry trailing spaces, e.g. "Turbo Radial Flow Compressor ". */
const clean = (value) => {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
};

/**
 * The two .dcf files of a Plant 3D project, kept alongside this module.
 * Both share the same PnPTables schema.
 */
const DCF_PATHS = {
  '2d': path.join(__dirname, 'ProcessPower.dcf'), // P&ID
  '3d': path.join(__dirname, 'Piping.dcf'), // piping
};

/** Used when no path is given. */
const BUNDLED_DCF = DCF_PATHS['2d'];

function resolveDcfPath(dcfPath) {
  const resolved = dcfPath || process.env.PROCESSPOWER_DCF || BUNDLED_DCF;
  if (!fs.existsSync(resolved)) {
    throw new Error(
      `.dcf not found at ${resolved} — pass a path or set PROCESSPOWER_DCF.`,
    );
  }
  return resolved;
}

/**
 * Raw rows from classHierarchy.sql, in depth-first order.
 * Each row: { Level, Hierarchy, TableName, DisplayName, ParentClass, Abstract }
 */
function queryClassHierarchy(dcfPath) {
  const sql = fs.readFileSync(SQL_PATH, 'utf8');
  return query(resolveDcfPath(dcfPath), sql);
}

/**
 * Folds the flat rows into a tree.
 *
 * ParentClass gives the edge, so the tree is built by lookup rather than by
 * tracking Level — that way a row arriving before its parent, or a Level that
 * skips a step, cannot corrupt the shape. Level is still carried on each node.
 *
 * Any row whose ParentClass is not in the result set becomes an extra root
 * instead of being silently dropped.
 */
function buildTree(rows) {
  const nodes = new Map();

  for (const row of rows) {
    nodes.set(row.TableName, {
      tableName: row.TableName,
      displayName: clean(row.DisplayName),
      level: row.Level,
      parentClass: clean(row.ParentClass),
      abstract: toBool(row.Abstract),
      children: [],
    });
  }

  const roots = [];
  for (const row of rows) {
    const node = nodes.get(row.TableName);
    const parent = row.ParentClass ? nodes.get(row.ParentClass) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/**
 * The hierarchy as a JSON tree. Returns an array of root nodes — ProcessPower.dcf
 * ships exactly one (`PnPBase`), so callers usually want `tree[0]`.
 *
 * Node shape:
 *   { tableName, displayName, level, parentClass, abstract, children[] }
 */
function getClassHierarchy(dcfPath) {
  return annotateFilters(buildTree(queryClassHierarchy(dcfPath)));
}

/**
 * The AEC Data Model property holding an element's class ancestry, and the
 * RSQL-ish filter template that queries it.
 */
const TABLE_NAMES_PARAM = 'autodesk.plant3d.parameter:tableNames-1.0.0';
const CLASS_NAME_PARAM = 'autodesk.plant3d.parameter:pnpClassName-1.0.0';
const buildFilter = (value) =>
  `property.id.${TABLE_NAMES_PARAM}=contains='${value}'`;

/** Branches that must be scanned rather than filtered — see annotateFilters. */
const SCAN_ONLY = new Set(['EngineeringItems', 'NonEngineeringItems']);

/**
 * Annotates every node with the AEC Data Model filter that selects its elements.
 *
 * An element's "Table Names" property is its class ancestry, leaf first and
 * excluding PnPBase:
 *
 *   GateValve  ->  "GateValve,HandValves,InLineAssets,EngineeringItems"
 *
 * So `tableNames =contains= '<chain from this class to the root>'` selects the
 * class and everything beneath it — the chain is anchored at the root end, and
 * any descendant's chain ends with the same suffix.
 *
 * IMPORTANT: `=contains=` is a substring test with no word boundary, so the
 * filter OVER-MATCHES whenever a sibling's name ends with this class's name:
 *
 *   'Filter,Filters,Equipment,…'  also matches  'ActivatedCarbonFilter,Filters,Equipment,…'
 *   'Primary,PipeLines,Lines,…'   also matches  'ExistingPrimary,PipeLines,Lines,…'
 *   'EngineeringItems'            also matches  'NonEngineeringItems'
 *
 * 43 of 709 classes are affected. Each node therefore also carries
 * `filterSafe` and `filterOverMatches`, so a caller can either post-filter the
 * results by exact chain or pick a narrower query. Nothing here silently
 * assumes the filter is exact.
 */
function annotateFilters(roots) {
  const index = indexByTableName(roots);

  // Chain per class, leaf -> root, excluding PnPBase.
  const chainOf = (node) => {
    const out = [];
    let n = node;
    while (n && n.tableName !== 'PnPBase') {
      out.push(n.tableName);
      n = n.parentClass ? index.get(n.parentClass) : null;
    }
    return out;
  };

  const classes = [...index.values()].filter((n) => n.tableName !== 'PnPBase');
  for (const node of classes) {
    node.tableNamesPath = chainOf(node);
    node.filterValue = node.tableNamesPath.join(',');
    node.filter = node.filterValue ? buildFilter(node.filterValue) : null;
  }

  // PnPBase never appears in Table Names, so it has no filter of its own.
  for (const root of roots) {
    if (root.tableName === 'PnPBase') {
      root.tableNamesPath = [];
      root.filterValue = null;
      root.filter = null;
      root.filterSafe = false;
      root.filterOverMatches = [];
      root.scanOnly = true;
    }
  }

  // Which classes each filter would wrongly pull in. O(n^2) over ~700 classes,
  // run once per process when the hierarchy is first read.
  const subtree = new Map();
  for (const node of classes) {
    const names = new Set();
    (function walk(n) {
      names.add(n.tableName);
      n.children.forEach(walk);
    })(node);
    subtree.set(node.tableName, names);
  }

  for (const node of classes) {
    const needle = node.filterValue;
    const mine = subtree.get(node.tableName);
    node.filterOverMatches = classes
      .filter((other) => !mine.has(other.tableName) && other.filterValue.includes(needle))
      .map((other) => other.tableName);
    node.filterSafe = node.filterOverMatches.length === 0;
    // The two content branches are scanned regardless: EngineeringItems is a
    // substring of NonEngineeringItems and `=contains=` cannot exclude.
    node.scanOnly = SCAN_ONLY.has(node.tableName);
  }

  return roots;
}

/* ---------- column types, for validity checks ---------- */

const COLUMN_TYPES_SQL = path.join(__dirname, 'columnTypes.sql');
const PICKLIST_SQL = path.join(__dirname, 'picklistValues.sql');

/**
 * Declared column types from the .dcf, keyed "TableName.ColumnName".
 *
 *   { type: 'PnPPickListType', picklistName: 'Pipe_Sizes', allowed: ['1/8"', …] }
 *
 * Columns are inherited, so resolve by walking a class's ancestry — see
 * `resolveColumnType`.
 */
function getColumnTypes(dcfPath) {
  const resolved = resolveDcfPath(dcfPath);

  const picklists = new Map(); // PicklistName -> Set(values)
  for (const row of query(resolved, fs.readFileSync(PICKLIST_SQL, 'utf8'))) {
    const name = clean(row.PicklistName);
    if (!name) continue;
    if (!picklists.has(name)) picklists.set(name, new Set());
    picklists.get(name).add(String(row.PicklistValue).trim());
  }

  const columns = new Map();
  for (const row of query(resolved, fs.readFileSync(COLUMN_TYPES_SQL, 'utf8'))) {
    const table = clean(row.TableName);
    const column = clean(row.ColumnName);
    if (!table || !column) continue;
    const picklistName = clean(row.PicklistName);
    columns.set(`${table}.${column}`, {
      table,
      column,
      type: clean(row.Type),
      picklistName,
      allowed: picklistName && picklists.has(picklistName) ? [...picklists.get(picklistName)] : null,
    });
  }
  return { columns, picklists };
}

/**
 * An AEC Data Model property definition id maps to a .dcf column by
 * capitalising its local name: `designPressure-1.0.0` -> `DesignPressure`.
 *
 * AECDM-synthesised properties (pnpId, pnpGuid, tableNames, …) have no .dcf
 * column and resolve to null — 10 of the 39 properties on a real element.
 */
function columnNameForProperty(definitionId) {
  const local = String(definitionId).split(':').pop().replace(/-[\d.]+$/, '');
  return local ? local[0].toUpperCase() + local.slice(1) : null;
}

/**
 * Type declaration for `column` as seen by a class, walking up the ancestry.
 * @param {Map} columns        from getColumnTypes()
 * @param {string[]} ancestry  leaf-first class chain (an element's Table Names)
 */
function resolveColumnType(columns, ancestry, column) {
  for (const table of ancestry) {
    const hit = columns.get(`${table}.${column}`);
    if (hit) return hit;
  }
  return null;
}

/* ---------- relationship types ---------- */

const REL_TYPES_SQL = path.join(__dirname, 'relationshipTypes.sql');
const REL_ENDPOINTS_SQL = path.join(__dirname, 'relationshipEndpoints.sql');

/**
 * Relationship types and their endpoint roles.
 *
 *   { typeName: 'LineOffPageConnector', endpoints: ['Line','OffPageConnector'],
 *     hasTable: true, filter: "property.id.…pnpClassName-1.0.0=contains='…'" }
 *
 * An element of a relationship type carries one property per endpoint, named
 * after the role, whose displayValue is the related element's PnPID.
 *
 * The type names have no substring collisions, so `=contains=` on pnpClassName
 * is exact for all 19 — unlike the class filters, where 43 over-match.
 */
function getRelationshipTypes(dcfPath) {
  const resolved = resolveDcfPath(dcfPath);

  const endpoints = new Map(); // typeName -> [role]
  for (const row of query(resolved, fs.readFileSync(REL_ENDPOINTS_SQL, 'utf8'))) {
    const type = clean(row.TypeName);
    const role = clean(row.Role);
    if (!type || !role) continue;
    if (!endpoints.has(type)) endpoints.set(type, []);
    endpoints.get(type).push(role);
  }

  return query(resolved, fs.readFileSync(REL_TYPES_SQL, 'utf8')).map((row) => {
    const typeName = clean(row.TypeName);
    const roles = endpoints.get(typeName) || [];
    return {
      typeName,
      physicalName: clean(row.PhysicalName),
      endpoints: roles,
      // Abstract types have no table, so no elements will ever come back.
      hasTable: roles.length > 0,
      filter: `property.id.${CLASS_NAME_PARAM}=contains='${typeName}'`,
    };
  });
}

/** Every endpoint role across all relationship types, for spotting pair properties. */
function relationshipRoles(dcfPath) {
  const roles = new Set();
  for (const type of getRelationshipTypes(dcfPath)) {
    for (const role of type.endpoints) roles.add(role);
  }
  return roles;
}

/** Flat `tableName -> node` index over a built tree, for lookups by class name. */
function indexByTableName(roots) {
  const index = new Map();
  const walk = (node) => {
    index.set(node.tableName, node);
    node.children.forEach(walk);
  };
  roots.forEach(walk);
  return index;
}

/** Counts for logging and tests: { total, roots, maxLevel, abstract, leaves }. */
function summarize(roots) {
  let total = 0;
  let maxLevel = 0;
  let abstract = 0;
  let leaves = 0;

  const walk = (node) => {
    total += 1;
    maxLevel = Math.max(maxLevel, node.level);
    if (node.abstract) abstract += 1;
    if (!node.children.length) leaves += 1;
    node.children.forEach(walk);
  };
  roots.forEach(walk);

  return { total, roots: roots.length, maxLevel, abstract, leaves };
}

module.exports = {
  DCF_PATHS,
  TABLE_NAMES_PARAM,
  CLASS_NAME_PARAM,
  buildFilter,
  getRelationshipTypes,
  relationshipRoles,
  annotateFilters,
  getClassHierarchy,
  getColumnTypes,
  columnNameForProperty,
  resolveColumnType,
  queryClassHierarchy,
  buildTree,
  indexByTableName,
  summarize,
};
