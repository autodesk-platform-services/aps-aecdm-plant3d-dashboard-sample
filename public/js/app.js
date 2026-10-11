const userBox = document.getElementById('user-box');
const treeEl = document.getElementById('tree');
const detailsEl = document.getElementById('details');

// Set from /api/config at boot: "folder" lists folders to pick from, "project" scans directly.
let extractGroupsWay = 'folder';

/* ---------- Header: signed-in user ---------- */

function renderSignedOut(message) {
  userBox.innerHTML = '';
  const button = document.createElement('button');
  button.className = 'primary-button';
  button.textContent = 'Sign in with Autodesk';
  button.addEventListener('click', () => {
    window.location.href = '/api/auth/login';
  });
  if (message) {
    const note = document.createElement('span');
    note.className = 'muted';
    note.textContent = message;
    userBox.append(note);
  }
  userBox.append(button);
  treeEl.innerHTML = '<p class="muted pad">Sign in to load your hubs.</p>';
}

function renderSignedIn(profile) {
  userBox.innerHTML = '';

  const avatar = document.createElement('img');
  avatar.src = profile.picture || '';
  avatar.alt = '';

  const meta = document.createElement('div');
  meta.className = 'user-meta';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = profile.name || 'Signed in';
  const email = document.createElement('span');
  email.className = 'email';
  email.textContent = profile.email || '';
  meta.append(name, email);

  const logout = document.createElement('button');
  logout.className = 'ghost-button';
  logout.textContent = 'Sign out';
  logout.addEventListener('click', () => {
    window.location.href = '/api/auth/logout';
  });

  userBox.append(avatar, meta, logout);
}

/* ---------- Left panel: hubs → projects → Plant 3D data sets ---------- */

/** The P&ID data set is the 2D side, backed by ProcessPower.dcf. */
const is2dDataSet = (name) => name.startsWith('P&ID');

/** 3D piping / model data sets — paired with P&ID for reconciliation. */
const is3dDataSet = (name) => !is2dDataSet(name) && /3D/i.test(name) && /Data Set/i.test(name);

/** The other Plant 3D data set in the same project folder (P&ID ↔ 3D). */
function findPeerDataSet(allDataSets, dataSet) {
  if (!allDataSets || !dataSet) return null;
  const twoD = is2dDataSet(dataSet.name);
  const threeD = is3dDataSet(dataSet.name);
  if (!twoD && !threeD) return null;
  return (
    allDataSets.find((ds) => ds.id !== dataSet.id && (twoD ? is3dDataSet(ds.name) : is2dDataSet(ds.name))) ||
    null
  );
}

// The class hierarchy is static, so fetch each kind at most once per page load.
const classHierarchyCache = new Map();

function loadClassHierarchy(kind) {
  if (!classHierarchyCache.has(kind)) {
    classHierarchyCache.set(
      kind,
      api.classes(kind).catch((err) => {
        classHierarchyCache.delete(kind); // let a later expand retry
        throw err;
      }),
    );
  }
  return classHierarchyCache.get(kind);
}

/**
 * One class from the .dcf schema. Children are already in memory, so expanding
 * is instant.
 *
 * `dataSet` is passed only for the first level under a branch, which gets its
 * own sync button. Deeper classes are browse-only — a sync icon on all 709
 * would invite hundreds of full fetches.
 */
function classNode(node, dataSet, syncContext) {
  const label = node.displayName || node.tableName;
  // Root-first, which is the order the API expects. tableNamesPath is leaf-first.
  const path = [...(node.tableNamesPath || [])].reverse();
  const ctx = syncContext || null;

  return {
    label,
    icon: node.abstract ? '🔸' : '🔹',
    // Show the table name whenever the label is the friendlier display name.
    hint: label === node.tableName ? null : node.tableName,
    action:
      ctx && dataSet && path.length
        ? {
            icon: '⟳',
            title: `Sync ${label} (${node.filterValue}) and chart it`,
            onClick: (button) => runSync(dataSet, { label, path }, button, ctx),
          }
        : null,
    onSelect: () => showClass(node),
    // Sub-classes are browse-only, so no sync context is handed down.
    loadChildren: node.children.length
      ? () => node.children.map((c) => classNode(c, dataSet))
      : null,
  };
}

/* ---------- overview sync + drill-down ---------- */

// Drill state per element group, so each branch keeps its own trail.
const drillState = new Map(); // `${elementGroupId}|${branch}` -> [{ tableName, label }]

/**
 * The right panel holds two stacked sections: the class overview and, under it,
 * the quality card. They are rebuilt together so drilling the overview also
 * resets the quality scope.
 */
function buildSections() {
  detailsEl.innerHTML = '';
  const overview = document.createElement('section');
  const quality = document.createElement('section');
  quality.className = 'quality-section';
  detailsEl.append(overview, quality);
  return { overview, quality };
}

/** Paints just the overview chart, leaving the quality host alone. */
function paintOverview(host, key, elementGroupId, result) {
  const crumbs = drillState.get(key) || [];
  overviewChart.render(host, result, crumbs, {
    onDrill: async (bucket) => {
      crumbs.push({ tableName: bucket.tableName, label: bucket.label });
      await showRollup(key, elementGroupId);
    },
    onCrumb: async (index) => {
      drillState.set(key, crumbs.slice(0, index + 1));
      await showRollup(key, elementGroupId);
    },
  });
}

/** Rebuilds both sections at once — used on drill-down, where both are cached. */
function renderOverview(key, elementGroupId, result, qualityResult) {
  const crumbs = drillState.get(key) || [];
  const { overview, quality } = buildSections();
  paintOverview(overview, key, elementGroupId, result);
  renderQuality(quality, elementGroupId, crumbs.map((c) => c.tableName), qualityResult);
}

/* ---------- quality ---------- */

/**
 * The quality card needs no button: the sync already fetched every element with
 * its values, so this is computed from the same cache. `result` is passed in
 * after a sync; on a drill-down it is re-read from the cache.
 */
async function renderQuality(container, elementGroupId, path, result) {
  const attach = (payload) =>
    qualityChart.render(container, payload, {
      onSelect: async (metric, host) => {
        host.innerHTML = '<p class="muted">Loading elements…</p>';
        try {
          const issues = await api.qualityIssues(elementGroupId, path, metric.key);
          qualityChart.renderIssues(host, metric, issues.rows);
        } catch (err) {
          host.innerHTML = '';
          const msg = document.createElement('p');
          msg.className = 'error';
          msg.textContent = err.message;
          host.append(msg);
        }
      },
    });

  if (result) return attach(result);

  qualityChart.renderPending(container, null);
  try {
    attach(await api.quality(elementGroupId, path));
  } catch (err) {
    container.innerHTML = '';
    const msg = document.createElement('p');
    msg.className = 'error';
    msg.textContent = err.message;
    container.append(msg);
  }
}

/** Regroup from the server-side cache — no APS traffic for either chart. */
async function showRollup(key, elementGroupId) {
  const crumbs = drillState.get(key) || [];
  const path = crumbs.map((c) => c.tableName);
  try {
    // Both come from the same cached elements, so fetch them together.
    const [overview, quality] = await Promise.all([
      api.rollup(elementGroupId, path),
      api.quality(elementGroupId, path),
    ]);
    renderOverview(key, elementGroupId, overview, quality);
  } catch (err) {
    showError(err);
  }
}

/**
 * Full sync: page every element of the data set once, then chart the branch and
 * assess its quality from that single fetch.
 * `branch` is EngineeringItems or NonEngineeringItems.
 */
/**
 * Fetches one scope and charts it. Used by the two branch nodes and by the
 * first level of classes beneath them.
 *
 * @param {object} dataSet          the element group
 * @param {object} scope            { label, path } — path is root-first
 * @param {HTMLElement} button      the ⟳ that triggered it
 */
async function runSync(dataSet, scope, button, syncContext = { kind: '2d', reconcileWith: null }) {
  const { label, path } = scope;
  const key = `${dataSet.id}|${path.join(',')}`;
  // Seed the breadcrumb trail with the whole path, so drilling can walk back up.
  drillState.set(
    key,
    path.map((tableName, i) => ({ tableName, label: i === path.length - 1 ? label : tableName })),
  );

  button.disabled = true;
  button.classList.add('spinning');

  const { overview: overviewHost, quality: qualityHost } = buildSections();

  // Keep the first chart's heading up during the sync so the panel does not
  // read as empty while it pages.
  const heading = document.createElement('h2');
  heading.textContent = 'Model / Data Overview';
  const status = document.createElement('p');
  status.className = 'muted';
  status.innerHTML = '<span class="spinner"></span> Starting sync…';
  overviewHost.append(heading, status);

  // Quality just waits while the overview pages — one fetch, one progress
  // indicator. Status line only, nothing else.
  qualityChart.renderStandby(qualityHost);

  let scanned = 0;
  try {
    const { quality } = await api.syncElementGroup(dataSet.id, path, {
      kind: syncContext.kind || '2d',
      reconcileWith: syncContext.reconcileWith || null,
      onProgress: (progress) => {
        if (progress.phase === 'scan') {
          scanned = progress.scanned;
          status.innerHTML =
            `<span class="spinner"></span> Fetched ${scanned.toLocaleString()} ` +
            `element${scanned === 1 ? '' : 's'} (page ${progress.pages})…`;
        } else if (progress.phase === 'assess') {
          qualityChart.renderPending(
            qualityHost,
            scanned,
            'Checking quality and P&ID ↔ 3D reconciliation…',
          );
        }
      },
      // Fires before the quality pass runs, so the first chart lands first.
      onOverview: (overview) => {
        paintOverview(overviewHost, key, dataSet.id, overview);
        console.log(
          `[overview] ${dataSet.name} / ${label}: ${overview.total} fetched, ` +
            `${overview.matched} in scope, ${overview.buckets.length} classes, ` +
            `${overview.pages} pages` +
            (overview.filtered ? ` (filtered: ${overview.filtered})` : ' (unfiltered scan)'),
        );
      },
    });

    const recon = quality.metrics.find((m) => m.key === 'reconciliation');
    console.log(
      `[quality] ${label}: completeness ${quality.metrics[0].percent}%, ` +
        `validity ${quality.metrics[1].percent}%` +
        (recon && recon.implemented ? `, reconciliation ${recon.percent}%` : '') +
        ` over ${quality.elements} elements`,
    );
    renderQuality(qualityHost, dataSet.id, path, quality);
  } catch (err) {
    showError(err);
  } finally {
    button.disabled = false;
    button.classList.remove('spinning');
  }
}

function showError(err) {
  detailsEl.innerHTML = '';
  const msg = document.createElement('p');
  msg.className = 'error';
  msg.textContent = err.message;
  detailsEl.append(msg);
}

/** One of the two content branches, with a sync button. */
function branchNode(dataSet, branch, syncContext) {
  return {
    label: branch.label,
    icon: branch.tableName === 'EngineeringItems' ? '⚙️' : '🏷️',
    hint: `${branch.children} sub-classes`,
    action: {
      icon: '⟳',
      title: `Sync ${branch.label} from AEC Data Model and chart it`,
      onClick: (button) =>
        runSync(dataSet, { label: branch.label, path: [branch.tableName] }, button, syncContext),
    },
    onSelect: () => showBranch(dataSet, branch),
    // Still browsable as a class tree, independent of the chart.
    loadChildren: async () => {
      const roots = await loadClassHierarchy(syncContext.kind);
      const found = findClass(roots, branch.tableName);
      // First level under a branch gets its own sync button.
      return found ? found.children.map((c) => classNode(c, dataSet, syncContext)) : [];
    },
  };
}

/* ---------- Relationship ---------- */

/**
 * Third top-level node, beside the two class branches. Its sub-nodes are the
 * relationship types from PnPRelationshipTypes.
 */
function relationshipNode(dataSet) {
  return {
    label: 'Relationship',
    icon: '🔗',
    action: {
      icon: '⟳',
      title: 'Fetch every relationship type and list the engineering items',
      onClick: (button) => syncRelationships(dataSet, button),
    },
    onSelect: () => showRelationshipRoot(dataSet),
    loadChildren: async () => {
      const types = await api.relationshipTypes();
      return types.map((type) => ({
        label: type.typeName,
        icon: type.hasTable ? '🔸' : '🔹',
        hint: type.hasTable ? type.endpoints.join(' + ') : 'abstract',
        onSelect: () => showRelationshipType(type),
      }));
    },
  };
}

/**
 * Fetches all relationship types, then replaces the panel with the engineering
 * items table. The table's rows come from the earlier Engineering Items sync,
 * so that has to have run first.
 */
async function syncRelationships(dataSet, button) {
  button.disabled = true;
  button.classList.add('spinning');

  detailsEl.innerHTML = '';
  const status = document.createElement('p');
  status.className = 'muted';
  status.innerHTML = '<span class="spinner"></span> Starting relationship sync…';
  detailsEl.append(status);

  try {
    const summary = await api.syncRelationships(dataSet.id, (progress) => {
      if (progress.phase === 'scan') {
        status.innerHTML =
          `<span class="spinner"></span> ${progress.typeName} ` +
          `(${progress.typeIndex}/${progress.typeCount}) — ` +
          `${progress.fetched.toLocaleString()} relationship element(s) so far…`;
      }
    });
    console.log(
      `[relationships] ${summary.total} elements across ${summary.types.length} types, ` +
        `${summary.pages} pages`,
    );
    // Clears the charts and shows the item table instead.
    await showItemsTable(dataSet, 1);
  } catch (err) {
    showError(err);
  } finally {
    button.disabled = false;
    button.classList.remove('spinning');
  }
}

/** The engineering-items table, paginated, with its pair panel. */
async function showItemsTable(dataSet, page) {
  detailsEl.innerHTML = '';
  const loading = document.createElement('p');
  loading.className = 'muted';
  loading.innerHTML = '<span class="spinner"></span> Loading engineering items…';
  detailsEl.append(loading);

  try {
    const result = await api.engineeringItems(dataSet.id, page, 50);
    itemsTable.render(detailsEl, result, {
      onPage: (next) => showItemsTable(dataSet, next),
      // The pair table and the schematic live in separate cards, so each gets
      // its own host.
      onRow: async (row, { pairHost, diagramHost }) => {
        itemsTable.pairHint(pairHost, 'Looking up relationships…');
        itemsTable.diagramHint(diagramHost, 'Looking up relationships…');
        try {
          const pairs = await api.pairs(dataSet.id, row.pnpId);
          itemsTable.renderPairs(pairHost, row, pairs);
          itemsTable.renderDiagram(diagramHost, row, pairs);
        } catch (err) {
          itemsTable.pairHint(pairHost, err.message);
          itemsTable.diagramHint(diagramHost, err.message);
        }
      },
    });
  } catch (err) {
    showError(err);
  }
}

function findClass(nodes, tableName) {
  for (const node of nodes) {
    if (node.tableName === tableName) return node;
    const hit = findClass(node.children, tableName);
    if (hit) return hit;
  }
  return null;
}

function dataSetNode(dataSet, plant3dProject, allDataSets) {
  const twoD = is2dDataSet(dataSet.name);
  const threeD = is3dDataSet(dataSet.name);
  const peer = findPeerDataSet(allDataSets, dataSet);
  const syncContext = {
    kind: twoD ? '2d' : '3d',
    reconcileWith: peer ? peer.id : null,
  };

  return {
    label: dataSet.name,
    icon: twoD ? '📐' : '🧱',
    onSelect: () => showDataSet(dataSet, plant3dProject, peer),
    // The 2D data set exposes only the two content branches; the remaining 22
    // PnPBase children are Plant 3D system tables and are hidden.
    loadChildren: twoD
      ? async (setStatus) => {
          setStatus('Loading classes…');
          const branches = await api.branches('2d');
          return [
            ...branches.map((branch) => branchNode(dataSet, branch, syncContext)),
            relationshipNode(dataSet),
          ];
        }
      : threeD
        ? async (setStatus) => {
            setStatus('Loading 3D classes…');
            const branches = await api.branches('3d');
            return branches.map((branch) => branchNode(dataSet, branch, syncContext));
          }
        : null,
  };
}

function plant3dProjectNode(group) {
  return {
    label: group.name,
    icon: '🏭',
    loadChildren: async () =>
      group.dataSets.map((ds) => dataSetNode(ds, group.name, group.dataSets)),
  };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Turns a progress event from the scan into a line of status text. */
function progressText(progress) {
  switch (progress.phase) {
    case 'start':
      return 'Starting scan…';
    case 'folders':
      return `Found ${plural(progress.folders, 'folder')} to scan…`;
    case 'scan':
      // Scanning several subtrees at once — show how many are done.
      if (progress.mode === 'folder' && progress.folders > 1) {
        return (
          `Folder ${progress.foldersDone}/${progress.folders} — ` +
          `${plural(progress.scanned, 'group')} scanned, ${progress.matched} found`
        );
      }
      return (
        `Scanned ${plural(progress.scanned, 'element group')} (page ${progress.pages}) — ` +
        `${progress.matched} found`
      );
    default:
      return 'Working…';
  }
}

/** Runs the scan and turns the result into Plant 3D project nodes. */
async function scanNode(project, folder, setStatus) {
  const { tree: groups, stats } = await api.plant3dStream(
    project.id,
    folder ? folder.id : null,
    (progress) => setStatus(progressText(progress)),
  );
  console.log(
    `[plant3d] ${project.name}${folder ? ' / ' + folder.name : ''} (${stats.mode} mode): ` +
      `scanned ${stats.scanned} element groups over ${stats.pages} page(s), ` +
      `matched ${stats.matched} data set(s)`,
  );
  return groups.map(plant3dProjectNode);
}

/** A first-level folder — expanding it scans that subtree and nothing else. */
function folderNode(project, folder) {
  const count = folder.subfolders ? folder.subfolders.length : 0;
  return {
    label: folder.name,
    icon: '📂',
    onSelect: () => showFolder(project, folder),
    loadChildren: (setStatus) => scanNode(project, folder, setStatus),
    hint: count ? `${count} subfolder${count === 1 ? '' : 's'}` : null,
  };
}

function projectNode(project) {
  return {
    label: project.name,
    icon: '📁',
    onSelect: () => showProject(project),
    loadChildren: async (setStatus) => {
      // In folder mode the user picks the subtree to scan, so list the project's
      // first-level folders instead of scanning everything up front.
      if (extractGroupsWay === 'folder') {
        setStatus('Loading folders…');
        const folders = await api.folders(project.id);
        return folders.map((folder) => folderNode(project, folder));
      }
      return scanNode(project, null, setStatus);
    },
  };
}

function hubNode(hub) {
  return {
    label: hub.name,
    icon: '🏢',
    loadChildren: async () => (await api.projects(hub.id)).map(projectNode),
  };
}

async function loadHubs() {
  treeEl.innerHTML = '<p class="muted pad"><span class="spinner"></span> Loading hubs…</p>';
  try {
    const hubs = await api.hubs();
    tree.render(treeEl, hubs.map(hubNode));
  } catch (err) {
    treeEl.innerHTML = '';
    const msg = document.createElement('p');
    msg.className = 'error pad';
    msg.textContent = err.message;
    treeEl.append(msg);
  }
}

/* ---------- Right panel ---------- */

function detailsTable(title, crumb, rows) {
  detailsEl.innerHTML = '';

  const heading = document.createElement('h2');
  heading.textContent = title;

  const sub = document.createElement('p');
  sub.className = 'crumb';
  sub.textContent = crumb;

  const dl = document.createElement('dl');
  for (const [key, value] of rows) {
    if (!value) continue;
    const dt = document.createElement('dt');
    dt.textContent = key;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.append(dt, dd);
  }

  detailsEl.append(heading, sub, dl);
}

function showProject(project) {
  detailsTable('ACC project', project.name, [
    ['AEC DM project id', project.id],
    ['Data Management id', project.dmProjectId],
  ]);
}

function showFolder(project, folder) {
  const subfolders = (folder.subfolders || []).map((f) => f.name).join(', ');
  detailsTable(folder.name, `Folder in ${project.name} — expand to scan this subtree`, [
    ['Folder id', folder.id],
    ['Subfolders', subfolders || '(none)'],
  ]);
}

function showRelationshipRoot(dataSet) {
  detailsTable('Relationship', `${dataSet.name} — press ⟳ to fetch all types`, [
    ['Source', 'PnPRelationshipTypes in ProcessPower.dcf'],
    ['Stored as', 'relationship_data'],
    ['Needs', 'an Engineering Items sync first, for the item table'],
  ]);
}

function showRelationshipType(type) {
  detailsTable(type.typeName, type.hasTable ? 'Relationship type' : 'Abstract relationship type', [
    ['Endpoints', type.endpoints.length ? type.endpoints.join(', ') : '(none — abstract)'],
    ['Physical table', type.physicalName || '(none)'],
    ['AECDM filter', type.filter],
    [
      'Holds elements',
      type.hasTable ? 'yes' : 'no — abstract types have no table, so they are not fetched',
    ],
  ]);
}

function showBranch(dataSet, branch) {
  detailsTable(branch.label, `${dataSet.name} — press ⟳ to sync and chart`, [
    ['Class', branch.tableName],
    ['Sub-classes', String(branch.children)],
    ['Element group id', dataSet.id],
    ['Table Names path', branch.filterValue],
    ['AECDM filter', branch.filter],
    [
      'Query strategy',
      branch.scanOnly
        ? `scan + group in memory (this filter also matches ${branch.filterOverMatches} other class(es))`
        : 'filterable',
    ],
  ]);
}

/** Rows describing the AEC Data Model filter attached to a class node. */
function filterRows(node) {
  if (!node.filter) return [['AECDM filter', '(none — PnPBase is not in Table Names)']];
  const rows = [
    ['Table Names path', node.tableNamesPath.join(',')],
    ['AECDM filter', node.filter],
  ];
  if (node.scanOnly) {
    rows.push([
      'Query strategy',
      'scan + group in memory — =contains= cannot separate EngineeringItems ' +
        'from NonEngineeringItems',
    ]);
  } else if (node.filterSafe) {
    rows.push(['Filter is exact', 'yes — matches this class and its subclasses only']);
  } else {
    const n = node.filterOverMatches.length;
    rows.push([
      'Filter is exact',
      `NO — =contains= also matches ${n} sibling class${n === 1 ? '' : 'es'} whose ` +
        `name ends with "${node.tableName}": ${node.filterOverMatches.slice(0, 5).join(', ')}` +
        `${n > 5 ? ', …' : ''}. Post-filter on the exact path.`,
    ]);
  }
  return rows;
}

function showClass(node) {
  detailsTable(node.displayName || node.tableName, `P&ID class — level ${node.level}`, [
    ['Table name', node.tableName],
    ['Display name', node.displayName || '(none)'],
    ['Parent class', node.parentClass || '(root)'],
    ['Abstract', node.abstract ? 'yes' : 'no'],
    ['Subclasses', String(node.children.length)],
    ...filterRows(node),
  ]);
}

function showDataSet(dataSet, plant3dProject, peer) {
  const rows = [
    ['ElementGroup id', dataSet.id],
    ['Folder', dataSet.folder],
    ['File URN', dataSet.fileUrn],
    ['File version URN', dataSet.fileVersionUrn],
  ];
  if (peer) {
    rows.push(['Reconciliation pair', `${peer.name} (${peer.id})`]);
  }
  detailsTable(dataSet.name, `Plant 3D project: ${plant3dProject}`, rows);
}

/* ---------- Boot ---------- */

document.getElementById('refresh-hubs').addEventListener('click', loadHubs);

(async function init() {
  try {
    renderSignedIn(await api.profile());
    const config = await api.config();
    extractGroupsWay = config.extractGroupsWay;
    console.log(`[config] ExtractGroupsWay=${extractGroupsWay}`);
    await loadHubs();
  } catch (err) {
    renderSignedOut(err.status === 401 ? '' : err.message);
  }
})();
