/**
 * P&ID ↔ 3D reconciliation by engineering Tag (not PnPId).
 *
 * Compares tagged elements from two element groups at the same class scope.
 * Spec, Status, and Area must agree when a tag appears on both sides.
 */

const CLASS_NAME_DEF = 'autodesk.plant3d.parameter:pnpClassName-1.0.0';
const PNP_ID_DEF = 'autodesk.plant3d.parameter:pnpId-1.0.0';
const TAG_DEF = 'autodesk.plant3d.parameter:tag-1.0.0';
const AREA_DEF = 'autodesk.plant3d.parameter:area-1.0.0';
const STATUS_DEF = 'autodesk.plant3d.parameter:status-1.0.0';
const SPEC_DEF = 'autodesk.plant3d.parameter:spec-1.0.0';

const COMPARE_FIELDS = [
  { key: 'spec', def: SPEC_DEF, label: 'Spec' },
  { key: 'status', def: STATUS_DEF, label: 'Status' },
  { key: 'area', def: AREA_DEF, label: 'Area' },
];

const isBlank = (v) => v === null || v === undefined || String(v).trim() === '';

const propsOf = (element) => (element.properties && element.properties.results) || [];

function readProp(element, definitionId) {
  const hit = propsOf(element).find((p) => p.definition && p.definition.id === definitionId);
  return hit && !isBlank(hit.displayValue) ? String(hit.displayValue).trim() : null;
}

function normalizeTag(tag) {
  return String(tag).trim().toUpperCase();
}

/** One tagged row for indexing. */
function taggedRecord(element, side) {
  const tag = readProp(element, TAG_DEF);
  if (!tag) return null;
  const attrs = {};
  for (const field of COMPARE_FIELDS) {
    attrs[field.key] = readProp(element, field.def);
  }
  return {
    side,
    tag,
    tagKey: normalizeTag(tag),
    pnpId: readProp(element, PNP_ID_DEF),
    className: readProp(element, CLASS_NAME_DEF),
    ...attrs,
  };
}

/**
 * Reconcile two element arrays (same scope on P&ID and 3D sides).
 *
 * @returns {{ metric: object, issues: object[] }}
 */
function assessReconciliation(pidElements, pipingElements) {
  const pidRows = pidElements.map((el) => taggedRecord(el, 'pid')).filter(Boolean);
  const p3dRows = pipingElements.map((el) => taggedRecord(el, '3d')).filter(Boolean);

  const pidByTag = new Map();
  const p3dByTag = new Map();
  const issues = [];

  for (const row of pidRows) {
    if (pidByTag.has(row.tagKey)) {
      issues.push(issueRow('duplicate_pid', row.tag, row, pidByTag.get(row.tagKey), 'Duplicate tag on P&ID'));
    } else {
      pidByTag.set(row.tagKey, row);
    }
  }
  for (const row of p3dRows) {
    if (p3dByTag.has(row.tagKey)) {
      issues.push(issueRow('duplicate_3d', row.tag, p3dByTag.get(row.tagKey), row, 'Duplicate tag in 3D'));
    } else {
      p3dByTag.set(row.tagKey, row);
    }
  }

  const allTags = new Set([...pidByTag.keys(), ...p3dByTag.keys()]);
  if (!allTags.size) {
    return {
      metric: {
        key: 'reconciliation',
        label: 'Reconciliation',
        percent: null,
        checked: 0,
        failed: 0,
        affected: 0,
        implemented: true,
        note: 'No tagged elements in this scope — assign Tag values to compare P&ID and 3D.',
      },
      issues: [],
    };
  }

  let matchedClean = 0;
  let checks = 0;

  for (const tagKey of allTags) {
    const pid = pidByTag.get(tagKey);
    const p3d = p3dByTag.get(tagKey);
    checks += 1;

    if (pid && !p3d) {
      issues.push(issueRow('pid_only', pid.tag, pid, null, 'Tag on P&ID only — no 3D match'));
      continue;
    }
    if (p3d && !pid) {
      issues.push(issueRow('model_only', p3d.tag, null, p3d, 'Tag in 3D only — no P&ID match'));
      continue;
    }

    const mismatches = [];
    for (const field of COMPARE_FIELDS) {
      const a = pid[field.key] || '';
      const b = p3d[field.key] || '';
      if (a !== b) {
        mismatches.push(`${field.label}: P&ID "${a || '—'}" vs 3D "${b || '—'}"`);
      }
    }
    if (mismatches.length) {
      issues.push(
        issueRow('mismatch', pid.tag, pid, p3d, mismatches.join('; ')),
      );
    } else {
      matchedClean += 1;
    }
  }

  const failed = checks - matchedClean;
  const pct = (ok, total) => (total ? Number(((ok / total) * 100).toFixed(1)) : null);

  const metric = {
    key: 'reconciliation',
    label: 'Reconciliation',
    percent: pct(matchedClean, checks),
    checked: checks,
    failed,
    affected: issues.length,
    implemented: true,
    note:
      'Unique tags in scope: matched on P&ID and 3D with agreeing Spec, Status, and Area.',
  };

  return { metric, issues: issues.sort((a, b) => a.tag.localeCompare(b.tag)) };
}

function issueRow(kind, tag, pid, p3d, detail) {
  return {
    kind,
    tag,
    pnpId: pid ? pid.pnpId : p3d ? p3d.pnpId : null,
    className: pid ? pid.className : p3d ? p3d.className : null,
    pidClass: pid ? pid.className : null,
    p3dClass: p3d ? p3d.className : null,
    pidPnpId: pid ? pid.pnpId : null,
    p3dPnpId: p3d ? p3d.pnpId : null,
    area: (pid && pid.area) || (p3d && p3d.area) || null,
    fields: detail,
  };
}

/** Metric shown when the paired data set has not been synced at this scope yet. */
function reconciliationPending(note) {
  return {
    key: 'reconciliation',
    label: 'Reconciliation',
    percent: null,
    checked: 0,
    failed: 0,
    affected: 0,
    implemented: false,
    note,
  };
}

module.exports = {
  assessReconciliation,
  reconciliationPending,
  taggedRecord,
  TAG_DEF,
};
