const {
  getColumnTypes,
  columnNameForProperty,
  resolveColumnType,
} = require('./schemas');
const { createLogger } = require('./logger');

const log = createLogger('app:quality');

/**
 * Data-quality scoring for a set of AEC Data Model elements.
 *
 *   Completeness — fields that are empty or null
 *   Validity     — values that do not match the type declared in the .dcf
 *
 * Cross-dataset P&ID ↔ 3D reconciliation lives in server/reconciliation.js and
 * is merged into the quality payload by server/overview.js.
 *
 * These need the full property bag, so the sync in server/overview.js fetches
 * whole elements once and both charts are derived from that single cache — no
 * second pass over the API.
 */

const TABLE_NAMES_DEF = 'autodesk.plant3d.parameter:tableNames-1.0.0';
const CLASS_NAME_DEF = 'autodesk.plant3d.parameter:pnpClassName-1.0.0';
const PNP_ID_DEF = 'autodesk.plant3d.parameter:pnpId-1.0.0';

/** Area exists on Equipment and Instrumentation, not on every class. */
const AREA_DEFS = ['autodesk.plant3d.parameter:area-1.0.0'];

/** Control characters are never valid in a Plant 3D field. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/**
 * Characters that suggest a placeholder or typo rather than real data. Found in
 * live data as Tag values "1045?", "1046?", "1047?". Note that `"` is excluded —
 * it is a legitimate inch mark (`4"-CS300-P-1054`).
 */
const SUSPICIOUS_CHARS = /[?*|<>`~]/;

const isBlank = (v) => v === null || v === undefined || String(v).trim() === '';

const propsOf = (element) => (element.properties && element.properties.results) || [];

function readProp(element, definitionId) {
  const hit = propsOf(element).find((p) => p.definition && p.definition.id === definitionId);
  return hit ? hit.displayValue : null;
}

function readAny(element, definitionIds) {
  for (const id of definitionIds) {
    const value = readProp(element, id);
    if (!isBlank(value)) return value;
  }
  return null;
}

/** Class ancestry, leaf first — the value of Table Names. */
function ancestryOf(element) {
  const raw = readProp(element, TABLE_NAMES_DEF);
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/* ---------- validity ---------- */

/**
 * Checks one value against its declared .dcf type.
 * @returns {string|null} reason it is invalid, or null when valid/unchecked
 */
function validate(value, declared) {
  if (isBlank(value)) return null; // emptiness is Completeness's business, not Validity's
  const text = String(value);

  if (CONTROL_CHARS.test(text)) return 'contains a control character';
  if (text !== text.trim()) return 'has leading or trailing whitespace';
  if (!declared || !declared.type) return null; // no declaration: cannot judge

  switch (declared.type) {
    case 'PnPNumberUnitType':
      // A number, optionally followed by a unit: "150", "2.5 bar", "-40 C".
      if (!/^-?\d+(?:[.,]\d+)?(?:\s*\S+)?$/.test(text)) return 'not numeric';
      return null;

    case 'PnPIntType':
      if (!/^-?\d+$/.test(text)) return 'not an integer';
      return null;

    case 'PnPFlagType':
      if (!/^(0|1|true|false|yes|no)$/i.test(text)) return 'not a flag value';
      return null;

    case 'PnPPickListType':
      // Only judge when the picklist is actually known.
      if (!declared.allowed || !declared.allowed.length) return null;
      if (!declared.allowed.some((allowed) => allowed.toLowerCase() === text.toLowerCase())) {
        return `not in picklist ${declared.picklistName}`;
      }
      return null;

    case 'PnPStringType':
      if (SUSPICIOUS_CHARS.test(text)) return 'contains an unexpected character';
      return null;

    default:
      return null;
  }
}

/* ---------- assessment ---------- */

/**
 * Scores a batch of elements.
 *
 * COMPLETENESS SCOPE — this is the important design decision. Counting every
 * empty property gives 48% on a real project, because ~24 of 39 properties
 * (Manufacturer, Supplier, Design Pressure, PWHT, …) are optional and blank on
 * every single element. That number measures Plant 3D's schema breadth, not the
 * project's data quality.
 *
 * So the denominator is "fields in use for this class": a field counts only if
 * at least one element of the same class has a value for it. A blank then means
 * a genuine gap rather than an unused optional field. On the reference data this
 * moves the score from 48.2% to 98.4%.
 *
 * @param {Array} elements  elements WITH their full property bag
 * @param {object} [options]
 * @param {string} [options.dcfPath]
 */
function assess(elements, options = {}) {
  const { columns } = getColumnTypes(options.dcfPath);

  // Pass 1: which (class, field) pairs are ever populated.
  const inUse = new Map(); // className -> Set(definitionId)
  for (const element of elements) {
    const className = readProp(element, CLASS_NAME_DEF) || '(unknown)';
    if (!inUse.has(className)) inUse.set(className, new Set());
    const used = inUse.get(className);
    for (const p of propsOf(element)) {
      if (!isBlank(p.displayValue) && p.definition) used.add(p.definition.id);
    }
  }

  let completeSlots = 0;
  let missingSlots = 0;
  let checkedValues = 0;
  let invalidValues = 0;

  const completenessIssues = [];
  const validityIssues = [];

  // Pass 2: score each element.
  for (const element of elements) {
    const className = readProp(element, CLASS_NAME_DEF) || '(unknown)';
    const ancestry = ancestryOf(element);
    const used = inUse.get(className) || new Set();

    const byDef = new Map();
    for (const p of propsOf(element)) if (p.definition) byDef.set(p.definition.id, p);

    const missingFields = [];
    const invalidFields = [];

    for (const definitionId of used) {
      const p = byDef.get(definitionId);
      const label = p ? p.name : definitionId;

      completeSlots += 1;
      if (!p || isBlank(p.displayValue)) {
        missingSlots += 1;
        missingFields.push(label);
        continue;
      }

      const column = columnNameForProperty(definitionId);
      const declared = column ? resolveColumnType(columns, ancestry, column) : null;
      checkedValues += 1;
      const reason = validate(p.displayValue, declared);
      if (reason) {
        invalidValues += 1;
        invalidFields.push(`${label} (${reason})`);
      }
    }

    if (missingFields.length || invalidFields.length) {
      const row = {
        elementId: element.id || null,
        pnpId: readProp(element, PNP_ID_DEF),
        area: readAny(element, AREA_DEFS),
        className,
      };
      if (missingFields.length) {
        completenessIssues.push({ ...row, fields: missingFields.sort().join(', ') });
      }
      if (invalidFields.length) {
        validityIssues.push({ ...row, fields: invalidFields.sort().join(', ') });
      }
    }
  }

  const pct = (ok, total) => (total ? Number(((ok / total) * 100).toFixed(1)) : null);

  const metrics = {
    completeness: {
      key: 'completeness',
      label: 'Completeness',
      percent: pct(completeSlots - missingSlots, completeSlots),
      checked: completeSlots,
      failed: missingSlots,
      affected: completenessIssues.length,
      implemented: true,
      note: 'Empty or null fields, counted only over fields in use for each class.',
    },
    validity: {
      key: 'validity',
      label: 'Validity',
      percent: pct(checkedValues - invalidValues, checkedValues),
      checked: checkedValues,
      failed: invalidValues,
      affected: validityIssues.length,
      implemented: true,
      note: 'Values that do not match the type declared in the project .dcf.',
    },
  };

  log(
    `assessed ${elements.length} element(s): completeness ${metrics.completeness.percent}% ` +
      `(${missingSlots}/${completeSlots}), validity ${metrics.validity.percent}% ` +
      `(${invalidValues}/${checkedValues})`,
  );

  return {
    elements: elements.length,
    metrics: [metrics.completeness, metrics.validity],
    issues: { completeness: completenessIssues, validity: validityIssues },
  };
}

module.exports = { assess, validate, ancestryOf, SUSPICIOUS_CHARS };
