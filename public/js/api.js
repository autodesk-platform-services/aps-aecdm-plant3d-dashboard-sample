/* Thin wrapper over the server API. */
const api = (() => {
  async function get(url) {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const error = new Error(body.error || `Request failed (${res.status})`);
      error.status = res.status;
      throw error;
    }
    return res.json();
  }

  return {
    config: () => get('/api/config'),
    profile: () => get('/api/auth/profile'),
    hubs: () => get('/api/hubs'),
    projects: (hubId) => get(`/api/hubs/${encodeURIComponent(hubId)}/projects`),
    folders: (projectId) => get(`/api/projects/${encodeURIComponent(projectId)}/folders`),
    classes: (kind) => get(`/api/schemas/classes?kind=${encodeURIComponent(kind)}`),
    branches: (kind = '2d') =>
      get(`/api/schemas/branches?kind=${encodeURIComponent(kind)}`),
    relationshipTypes: () => get('/api/schemas/relationships'),

    /** A page of engineering items from engineering_items_overview_data. */
    engineeringItems: (elementGroupId, page, size) =>
      get(
        `/api/elementgroups/${encodeURIComponent(elementGroupId)}/engineering-items` +
          `?page=${page}&size=${size}`,
      ),

    /** Elements paired with pnpId, via relationship_data. */
    pairs: (elementGroupId, pnpId) =>
      get(
        `/api/elementgroups/${encodeURIComponent(elementGroupId)}/pairs` +
          `?pnpId=${encodeURIComponent(pnpId)}`,
      ),

    /** Fetches every relationship type in turn; resolves with the summary. */
    syncRelationships: (elementGroupId, onProgress) =>
      new Promise((resolve, reject) => {
        const source = new EventSource(
          `/api/elementgroups/${encodeURIComponent(elementGroupId)}/relationships/sync`,
        );
        source.addEventListener('progress', (e) => {
          if (onProgress) onProgress(JSON.parse(e.data));
        });
        source.addEventListener('done', (e) => {
          source.close();
          resolve(JSON.parse(e.data));
        });
        source.addEventListener('failed', (e) => {
          source.close();
          reject(new Error(JSON.parse(e.data).error));
        });
        source.onerror = () => {
          source.close();
          reject(new Error('Lost connection during the relationship sync'));
        };
      }),

    /** Drill-down against the cached sync — instant, no APS call. */
    rollup: (elementGroupId, path) =>
      get(
        `/api/elementgroups/${encodeURIComponent(elementGroupId)}/rollup` +
          `?path=${encodeURIComponent(path.join(','))}`,
      ),

    /** Element rows behind one quality metric — served from the last check. */
    qualityIssues: (elementGroupId, path, metric) =>
      get(
        `/api/elementgroups/${encodeURIComponent(elementGroupId)}/quality/issues` +
          `?path=${encodeURIComponent(path.join(','))}&metric=${encodeURIComponent(metric)}`,
      ),

    /** Quality summary for a scope, from the cached sync. */
    quality: (elementGroupId, path) =>
      get(
        `/api/elementgroups/${encodeURIComponent(elementGroupId)}/quality` +
          `?path=${encodeURIComponent(path.join(','))}`,
      ),

    /**
     * Full sync of an element group, streamed.
     *
     * `onOverview` fires as soon as paging finishes — before the quality pass —
     * so the first chart can render while the second is still being computed.
     * Resolves with { quality } once that finishes.
     */
    syncElementGroup: (
      elementGroupId,
      path,
      { onProgress, onOverview, kind = '2d', reconcileWith = null } = {},
    ) =>
      new Promise((resolve, reject) => {
        const params = new URLSearchParams();
        if (path.length) params.set('path', path.join(','));
        params.set('kind', kind);
        if (reconcileWith) params.set('reconcileWith', reconcileWith);
        const source = new EventSource(
          `/api/elementgroups/${encodeURIComponent(elementGroupId)}/sync?${params}`,
        );
        source.addEventListener('progress', (e) => {
          if (onProgress) onProgress(JSON.parse(e.data));
        });
        source.addEventListener('overview', (e) => {
          if (onOverview) onOverview(JSON.parse(e.data));
        });
        source.addEventListener('done', (e) => {
          source.close();
          resolve(JSON.parse(e.data));
        });
        source.addEventListener('failed', (e) => {
          source.close();
          reject(new Error(JSON.parse(e.data).error));
        });
        source.onerror = () => {
          source.close();
          reject(new Error('Lost connection to the server during the sync'));
        };
      }),
    plant3d: (projectId) => get(`/api/projects/${encodeURIComponent(projectId)}/plant3d`),

    /**
     * Streaming variant. Resolves with { tree, stats } once the scan finishes, calling
     * onProgress with each { phase, … } event along the way.
     * Pass folderId to scan just that folder subtree.
     */
    plant3dStream: (projectId, folderId, onProgress) =>
      new Promise((resolve, reject) => {
        const source = new EventSource(
          `/api/projects/${encodeURIComponent(projectId)}/plant3d/stream` +
            (folderId ? `?folderId=${encodeURIComponent(folderId)}` : ''),
        );

        source.addEventListener('progress', (event) => {
          if (onProgress) onProgress(JSON.parse(event.data));
        });
        source.addEventListener('done', (event) => {
          source.close();
          resolve(JSON.parse(event.data));
        });
        source.addEventListener('failed', (event) => {
          source.close();
          reject(new Error(JSON.parse(event.data).error));
        });
        // Fires on a dropped connection too; EventSource would otherwise retry forever.
        source.onerror = () => {
          source.close();
          reject(new Error('Lost connection to the server during the scan'));
        };
      }),
  };
})();
