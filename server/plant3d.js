const {
  graphql,
  GET_ELEMENT_GROUPS_BY_PROJECT,
  GET_FOLDERS_BY_PROJECT,
  GET_ELEMENT_GROUPS_BY_FOLDER,
} = require('./aecdm');
const {
  PLANT3D_DATASET_NAMES,
  AECDM_PAGE_LIMIT,
  EXTRACT_GROUPS_WAY,
  FOLDER_SCAN_CONCURRENCY,
} = require('./config');
const { createLogger } = require('./logger');

const log = createLogger('app:plant3d');

const UNGROUPED = 'Ungrouped';

const isDataSet = (name) =>
  Boolean(name) && PLANT3D_DATASET_NAMES.some((known) => name.trim() === known);

/** Throws if the caller (usually a disconnected browser) has given up. */
function throwIfAborted(signal) {
  if (signal && signal.aborted) {
    const error = new Error('Scan cancelled');
    error.cancelled = true;
    throw error;
  }
}

/** Runs fn over items, at most `limit` in flight. Results keep input order. */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;

  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i], i);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Walks one cursor-paginated element-group query, keeping only the Plant 3D data sets.
 * `onPage` reports each page so callers can aggregate progress across parallel scans.
 */
async function pageElementGroups(accessToken, query, field, variables, { signal, onPage }) {
  const dataSets = [];
  let cursor = null;
  let pages = 0;
  let scanned = 0;

  do {
    throwIfAborted(signal);

    const data = await graphql(accessToken, query, {
      ...variables,
      filter: { searchType: 'ALL' },
      pagination: { limit: AECDM_PAGE_LIMIT, cursor },
    });

    const page = data[field];
    const results = page.results || [];
    const matched = results.filter((group) => isDataSet(group.name));

    scanned += results.length;
    pages += 1;
    dataSets.push(...matched);
    cursor = page.pagination ? page.pagination.cursor : null;

    // Names that were scanned but rejected — the usual cause of an empty tree.
    if (log.enabled && !matched.length && results.length) {
      log('  rejected:', results.map((g) => g.name).join(' | '));
    }
    if (onPage) onPage({ results: results.length, matched: matched.length });
  } while (cursor);

  return { dataSets, pages, scanned };
}

/**
 * "project" mode — one cursor walk over every element group in the project.
 * Straightforward, but the scan is unbounded and times out on large projects.
 */
async function fetchByProject(accessToken, projectId, { onProgress, signal } = {}) {
  let pages = 0;
  let scanned = 0;
  let matched = 0;

  const { dataSets } = await pageElementGroups(
    accessToken,
    GET_ELEMENT_GROUPS_BY_PROJECT,
    'elementGroupsByProject',
    { projectId },
    {
      signal,
      onPage: (page) => {
        pages += 1;
        scanned += page.results;
        matched += page.matched;
        log(`page ${pages}: ${page.results} group(s), ${page.matched} data set(s)`);
        if (onProgress) onProgress({ phase: 'scan', mode: 'project', pages, scanned, matched });
      },
    },
  );

  return { dataSets, stats: { mode: 'project', pages, scanned, matched: dataSets.length } };
}

/**
 * The project's first-level folders, each with its immediate subfolders. This is what
 * the UI lists so the user can pick which subtree to scan.
 */
async function getFolders(accessToken, projectId) {
  const data = await graphql(accessToken, GET_FOLDERS_BY_PROJECT, { projectId });
  const roots = (data.foldersByProject && data.foldersByProject.results) || [];

  return roots.map((root) => ({
    id: root.id,
    name: root.name,
    subfolders: ((root.folders && root.folders.results) || []).map((f) => ({
      id: f.id,
      name: f.name,
    })),
  }));
}

/**
 * "folder" mode — scan folder subtrees with elementGroupsByFolderAndSubFolders.
 *
 * Pass `folderId` to scan exactly that subtree, which is what the UI does once the
 * user picks a folder. Without one, every first-level folder is scanned, several at
 * a time — still useful for curl and for the non-streaming route.
 */
async function fetchByFolder(accessToken, projectId, { folderId, onProgress, signal } = {}) {
  throwIfAborted(signal);

  let targets;
  if (folderId) {
    targets = [{ id: folderId, name: folderId }];
  } else {
    const roots = await getFolders(accessToken, projectId);
    targets = roots.map((root) => ({ id: root.id, name: root.name }));
  }

  log(`scanning ${targets.length} folder subtree(s)`);
  if (onProgress) onProgress({ phase: 'folders', folders: targets.length });

  let pages = 0;
  let scanned = 0;
  let matched = 0;
  let foldersDone = 0;

  const report = () => {
    if (onProgress) {
      onProgress({
        phase: 'scan',
        mode: 'folder',
        pages,
        scanned,
        matched,
        foldersDone,
        folders: targets.length,
      });
    }
  };

  const perFolder = await mapWithConcurrency(targets, FOLDER_SCAN_CONCURRENCY, async (folder) => {
    const result = await pageElementGroups(
      accessToken,
      GET_ELEMENT_GROUPS_BY_FOLDER,
      'elementGroupsByFolderAndSubFolders',
      { projectId, folderId: folder.id },
      {
        signal,
        onPage: (page) => {
          pages += 1;
          scanned += page.results;
          matched += page.matched;
          report();
        },
      },
    );
    foldersDone += 1;
    log(`"${folder.name}": ${result.scanned} group(s), ${result.dataSets.length} data set(s)`);
    report();
    return result.dataSets;
  });

  const dataSets = perFolder.flat();
  return {
    dataSets,
    stats: {
      mode: 'folder',
      pages,
      scanned,
      matched: dataSets.length,
      folders: targets.length,
    },
  };
}

/**
 * Steps 1-3 of the skill. Which query strategy runs is set by ExtractGroupsWay in .env.
 */
async function fetchDataSets(accessToken, projectId, options = {}) {
  // An explicit folderId always means a folder scan, whatever the configured default.
  const mode = options.folderId ? 'folder' : options.mode || EXTRACT_GROUPS_WAY;
  log(`scanning project ${projectId} via "${mode}"`);

  const result =
    mode === 'project'
      ? await fetchByProject(accessToken, projectId, options)
      : await fetchByFolder(accessToken, projectId, options);

  log(
    `scanned ${result.stats.scanned} group(s) over ${result.stats.pages} page(s), ` +
      `matched ${result.stats.matched}`,
  );
  return result;
}

/**
 * Step 4: group the data sets under their parent's parent folder — the Plant 3D project.
 * Both queries ask for parentFolder.parentFolder, so this needs no further API calls.
 */
function buildTree(dataSets) {
  const groups = new Map();

  for (const dataSet of dataSets) {
    const parent = dataSet.parentFolder;
    const grandparent = parent && parent.parentFolder;
    const key = (grandparent && grandparent.id) || UNGROUPED;

    if (!groups.has(key)) {
      groups.set(key, {
        id: grandparent ? grandparent.id : null,
        name: (grandparent && grandparent.name) || UNGROUPED,
        dataSets: [],
      });
    }
    groups.get(key).dataSets.push({
      id: dataSet.id,
      name: dataSet.name,
      folder: parent ? parent.name : null,
      fileUrn: dataSet.alternativeIdentifiers ? dataSet.alternativeIdentifiers.fileUrn : null,
      fileVersionUrn: dataSet.alternativeIdentifiers
        ? dataSet.alternativeIdentifiers.fileVersionUrn
        : null,
    });
  }

  const tree = [...groups.values()];
  for (const group of tree) group.dataSets.sort((a, b) => a.name.localeCompare(b.name));
  tree.sort((a, b) => {
    if (a.name === UNGROUPED) return 1;
    if (b.name === UNGROUPED) return -1;
    return a.name.localeCompare(b.name);
  });
  return tree;
}

/** Full skill run for one ACC project. */
async function getPlant3dTree(accessToken, projectId, options = {}) {
  const { dataSets, stats } = await fetchDataSets(accessToken, projectId, options);
  return { tree: buildTree(dataSets), stats };
}

module.exports = {
  getPlant3dTree,
  getFolders,
  fetchDataSets,
  buildTree,
  fetchByProject,
  fetchByFolder,
};
