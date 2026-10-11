const express = require('express');
const { requireAuth } = require('../auth');
const { getHubs, getProjects } = require('../aecdm');
const { getPlant3dTree, getFolders } = require('../plant3d');
const { getClassHierarchy, summarize, DCF_PATHS } = require('../schemas');
const {
  syncOverview,
  rollupCached,
  qualityCached,
  issuesFor,
  TOP_BRANCHES,
} = require('../overview');
const { EXTRACT_GROUPS_WAY } = require('../config');
const { getRelationshipTypes } = require('../schemas');
const { syncRelationships, engineeringItems, pairsFor } = require('../relationships');

const router = express.Router();
router.use(requireAuth);

// Lets the UI know whether to list folders or scan the whole project.
router.get('/config', (req, res) => {
  res.json({ extractGroupsWay: EXTRACT_GROUPS_WAY });
});

router.get('/hubs', async (req, res, next) => {
  try {
    const hubs = await getHubs(req.accessToken);
    res.json(hubs);
  } catch (err) {
    next(err);
  }
});

router.get('/hubs/:hubId/projects', async (req, res, next) => {
  try {
    const projects = await getProjects(req.accessToken, req.params.hubId);
    res.json(
      projects.map((project) => ({
        id: project.id,
        name: project.name,
        dmProjectId: project.alternativeIdentifiers
          ? project.alternativeIdentifiers.dataManagementAPIProjectId
          : null,
      })),
    );
  } catch (err) {
    next(err);
  }
});

/**
 * Class hierarchy from a bundled .dcf — ?kind=2d reads ProcessPower.dcf (P&ID),
 * ?kind=3d reads Piping.dcf. Static schema data, so it is read once and cached.
 */
const hierarchyCache = new Map();

router.get('/schemas/classes', (req, res, next) => {
  const kind = req.query.kind === '3d' ? '3d' : '2d';
  try {
    if (!hierarchyCache.has(kind)) {
      const tree = getClassHierarchy(DCF_PATHS[kind]);
      hierarchyCache.set(kind, tree);
      console.log(`[schemas] loaded ${kind} hierarchy — ${JSON.stringify(summarize(tree))}`);
    }
    res.json(hierarchyCache.get(kind));
  } catch (err) {
    next(err);
  }
});

/* ---------- overview charts ---------- */

const parsePath = (raw) =>
  (raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Full sync of one element group, streamed. Pages every element ONCE with its
 * full property bag, caches it, and returns both the class rollup and the
 * quality assessment for ?path=.
 *
 * The overview is emitted as soon as paging finishes, before the quality pass
 * runs, so the first chart can render while the second is still working.
 *
 * Events: progress { phase:"scan"|"assess", pages, scanned } ·
 *         overview { buckets, … } · done { quality } · failed
 */
router.get('/elementgroups/:elementGroupId/sync', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const controller = new AbortController();
  req.on('close', () => controller.abort());
  const send = (event, data) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('progress', { phase: 'start' });

  try {
    const { quality } = await syncOverview(req.accessToken, req.params.elementGroupId, {
      path: parsePath(req.query.path),
      dcfKind: req.query.kind === '3d' ? '3d' : '2d',
      reconcileWithElementGroupId: req.query.reconcileWith || null,
      onProgress: (progress) => send('progress', progress),
      onOverview: (overview) => send('overview', overview),
      signal: controller.signal,
    });
    send('done', { quality });
  } catch (err) {
    if (!err.cancelled) send('failed', { error: err.message });
  } finally {
    res.end();
  }
});

/**
 * Drill-down: regroup the already-synced element group at a deeper path.
 * In-memory, so this is what makes clicking a bar instant. 409 if not synced.
 */
router.get('/elementgroups/:elementGroupId/rollup', (req, res, next) => {
  try {
    const result = rollupCached(req.params.elementGroupId, parsePath(req.query.path));
    if (!result) {
      return res.status(409).json({ error: 'Not synced yet — run the sync first.' });
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * Quality summary for a scope, recomputed from the cached elements. No APS
 * traffic — the sync already fetched everything. 409 until a sync has run.
 */
router.get('/elementgroups/:elementGroupId/quality', (req, res, next) => {
  try {
    const result = qualityCached(req.params.elementGroupId, parsePath(req.query.path));
    if (!result) {
      return res.status(409).json({ error: 'Not synced yet — run the sync first.' });
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/** The element rows behind one quality metric. 409 until a sync has run. */
router.get('/elementgroups/:elementGroupId/quality/issues', (req, res, next) => {
  try {
    const metric = ['completeness', 'validity', 'reconciliation'].includes(req.query.metric)
      ? req.query.metric
      : 'completeness';
    const result = issuesFor(req.params.elementGroupId, parsePath(req.query.path), metric);
    if (!result) {
      return res.status(409).json({ error: 'Not synced yet — run the sync first.' });
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/* ---------- relationships ---------- */

/** The relationship types, for the Relationship node's sub-nodes. */
router.get('/schemas/relationships', (req, res, next) => {
  try {
    res.json(getRelationshipTypes());
  } catch (err) {
    next(err);
  }
});

/**
 * Fetches every relationship type in turn and stores them as relationship_data.
 * Events: progress { phase:"scan", typeName, typeIndex, typeCount, fetched } ·
 *         done { total, types, … } · failed
 */
router.get('/elementgroups/:elementGroupId/relationships/sync', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const controller = new AbortController();
  req.on('close', () => controller.abort());
  const send = (event, data) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('progress', { phase: 'start' });

  try {
    const summary = await syncRelationships(req.accessToken, req.params.elementGroupId, {
      onProgress: (progress) => send('progress', progress),
      signal: controller.signal,
    });
    send('done', summary);
  } catch (err) {
    if (!err.cancelled) send('failed', { error: err.message });
  } finally {
    res.end();
  }
});

/** A page of engineering items from engineering_items_overview_data. */
router.get('/elementgroups/:elementGroupId/engineering-items', (req, res, next) => {
  try {
    const result = engineeringItems(req.params.elementGroupId, {
      page: Number(req.query.page) || 1,
      size: Math.min(Number(req.query.size) || 50, 500),
    });
    if (!result) {
      return res.status(409).json({
        error: 'Sync Engineering Items first — its data is the source for this table.',
      });
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/** Elements paired with ?pnpId= , resolved through relationship_data. */
router.get('/elementgroups/:elementGroupId/pairs', (req, res, next) => {
  try {
    if (!req.query.pnpId) return res.status(400).json({ error: 'pnpId is required' });
    const result = pairsFor(req.params.elementGroupId, req.query.pnpId);
    if (!result) {
      return res.status(409).json({ error: 'Sync Relationship first.' });
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/** The class branches the UI offers; everything else in the .dcf is system metadata. */
router.get('/schemas/branches', (req, res, next) => {
  try {
    const kind = req.query.kind === '3d' ? '3d' : '2d';
    const branches = kind === '3d' ? ['EngineeringItems'] : TOP_BRANCHES;
    const roots = getClassHierarchy(DCF_PATHS[kind]);
    const index = new Map();
    const walk = (n) => {
      index.set(n.tableName, n);
      n.children.forEach(walk);
    };
    roots.forEach(walk);

    res.json(
      branches.map((tableName) => {
        const node = index.get(tableName);
        return node
          ? {
              tableName,
              label: node.displayName || tableName,
              children: node.children.length,
              filter: node.filter,
              filterValue: node.filterValue,
              filterSafe: node.filterSafe,
              filterOverMatches: node.filterOverMatches.length,
              scanOnly: node.scanOnly,
            }
          : { tableName, label: tableName, children: 0 };
      }),
    );
  } catch (err) {
    next(err);
  }
});

// First-level folders of a project, so the user can pick which subtree to scan.
router.get('/projects/:projectId/folders', async (req, res, next) => {
  try {
    res.json(await getFolders(req.accessToken, req.params.projectId));
  } catch (err) {
    next(err);
  }
});

// Plant 3D data set discovery for one ACC project (non-streaming).
// ?folderId=… scans just that folder subtree; ?mode=project|folder overrides
// ExtractGroupsWay for a single call.
router.get('/projects/:projectId/plant3d', async (req, res, next) => {
  try {
    const result = await getPlant3dTree(req.accessToken, req.params.projectId, {
      mode: req.query.mode,
      folderId: req.query.folderId,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * Same scan, streamed as Server-Sent Events. The element-group scan is unbounded —
 * a large project is many pages — so the UI needs progress rather than a spinner.
 *
 * Events: progress { phase: 'scan' | 'resolve', … } · done { tree, stats } · failed { error }
 */
router.get('/projects/:projectId/plant3d/stream', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // don't let a proxy buffer the stream
  });
  res.flushHeaders();

  // Stop paging APS the moment the browser goes away.
  const controller = new AbortController();
  req.on('close', () => controller.abort());

  const send = (event, data) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('progress', { phase: 'start' });

  try {
    const result = await getPlant3dTree(req.accessToken, req.params.projectId, {
      mode: req.query.mode,
      folderId: req.query.folderId,
      onProgress: (progress) => send('progress', progress),
      signal: controller.signal,
    });
    send('done', result);
  } catch (err) {
    if (!err.cancelled) send('failed', { error: err.message });
  } finally {
    res.end();
  }
});

module.exports = router;
