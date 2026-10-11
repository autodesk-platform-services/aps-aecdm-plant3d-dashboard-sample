# Autodesk APS AEC Data Model — Plant 3D Dashboard Sample

![platforms](https://img.shields.io/badge/platform-windows%20%7C%20osx%20%7C%20linux-lightgray.svg)
[![node.js](https://img.shields.io/badge/Node.js-22%20%7C%2020.11%20%7C%2018+-blue.svg)](https://nodejs.org)
[![npm](https://img.shields.io/badge/npm-10%2B-blue.svg)](https://www.npmjs.com/)
[![express](https://img.shields.io/badge/express-4.x-green.svg)](https://expressjs.com/)
[![license](https://img.shields.io/:license-mit-green.svg)](https://opensource.org/licenses/MIT)

[![AEC Data Model API](https://img.shields.io/badge/AEC%20Data%20Model-API-0696D7.svg)](https://aps.autodesk.com/en/docs/aecdatamodel/v1)

[![@aps_sdk/authentication](https://img.shields.io/badge/%40aps_sdk%2Fauthentication-npm-CB3837.svg)](https://www.npmjs.com/package/@aps_sdk/authentication)

## Description
A Node.js web application builds statistic of engineering items and breakdown view. It performs element quality checking by completeness, validity and reconciliation . It also gets all relationships and the relationships of given item & schematic view.  

## Thumbnail




## Demo




### Project layout

- [server/index.js](server/index.js) — Express app, static files, session
- [server/auth.js](server/auth.js) — 3-legged OAuth with `@aps_sdk/authentication`
- [server/aecdm.js](server/aecdm.js) — AEC Data Model GraphQL client
- [server/plant3d.js](server/plant3d.js) — Plant 3D data set discovery and tree building
- [server/overview.js](server/overview.js) — element sync, overview rollup, quality cache
- [server/quality.js](server/quality.js) — completeness and validity
- [server/reconciliation.js](server/reconciliation.js) — P&ID ↔ 3D tag reconciliation
- [server/relationships.js](server/relationships.js) — relationship sync and PnPId pairing
- [server/schemas/](server/schemas/) — `.dcf` hierarchy, column types, CLI dump. for fetching database tables schemas
- [server/routes/api.js](server/routes/api.js) — REST and SSE routes
- [public/](public/) — dashboard UI (vanilla JS, ECharts from CDN)
- 
## Prerequisites

- [APS app credentials](https://aps.autodesk.com/myapps/) — **Traditional Web App** with **AEC Data Model API**, **User Profiles API** enabled
- OAuth callback registered on the app: `http://localhost:8080/api/auth/callback` (adjust if you change `PORT` or `APS_CALLBACK_URL`)
- A Forma **hub and project** that contains at least one **Plant 3D** project data. If unavaialble yet, follow [this tutorial](https://help.autodesk.com/view/PLNT3D/2027/ENU/?guid=GUID-9DDB64C5-DB59-4E78-9105-2B647BABC8A6) to publish one. 
- Signed-in user with access to that hub and project (OAuth consent does not grant membership you do not already have)
- Node.js **22 or newer** (Node **20.11+** or **18+** is also compatible per `package.json`) and npm
- Optional: **`sqlite3` CLI** (3.33+) if Node does not provide `node:sqlite` — used read-only for bundled `.dcf` schema tools
- bash-compatible terminal

## Steps to build and run the sample locally

1. Clone the repository and run `npm install`.

   ```sh
   git clone https://github.com/autodesk-platform-services/aps-aecdm-plant3d-dashboard-sample.git
   cd aps-aecdm-plant3d-dashboard-sample
   npm install
   ```

2. Create `.env` from `.env.example`. Set `APS_CLIENT_ID` and `APS_CLIENT_SECRET`. Never commit credentials or expose them in browser code.

3. Register this OAuth callback URL on the APS app: `http://localhost:8080/api/auth/callback` (must match `APS_CALLBACK_URL`).

4. Set `SERVER_SESSION_SECRET` to a long random value, for example:

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

5. Optional: set `ExtractGroupsWay=folder` (default) or `project`, `AECDM_PAGE_LIMIT` (1–99), and `DEBUG=app:plant3d` for scan diagnostics. See [.env.example](.env.example).

6. Run `npm start` and open [http://localhost:8080](http://localhost:8080). Restart after changing `.env`.

If port 8080 is in use, set `PORT`, update `APS_CALLBACK_URL`, and register the matching callback on the APS app.

### Commands

```sh
npm start
npm run dev
npm run debug
npm run schema:dump -- server/schemas/ProcessPower.dcf --tree
```

## Usage

After the app is running locally (see [Development](#development)), open [http://localhost:8080](http://localhost:8080), choose **Sign in with Autodesk**, and approve access.

### Dashboard workflow

- Hubs and projects come from the AEC Data Model. Expanding a hub loads its projects; expanding a project either lists **first-level ACC folders** (`ExtractGroupsWay=folder`, default) or scans the whole project (`ExtractGroupsWay=project`).
- In **folder** mode, expand a folder (for example **Project Files**) to run a **Plant 3D scan** with live progress. The scan finds element groups named **P&ID Data Set**, **3D Piping Data Set**, or **3D Models Data Set** and groups them under the Plant 3D project folder (🏭).
- Select a **P&ID Data Set** or **3D Piping Data Set** row (not a child class) to see details, including the **Reconciliation pair** element group id for the other data set in the same Plant 3D project.
- **P&ID Data Set** expands to **Engineering Items**, **Non Engineering Items**, and **Relationship**. **3D Piping Data Set** expands to **Engineering Items** and first-level classes (**Equipment**, **Fasteners**, **PipeRunComponent**).
- Click **sync incon** on a branch or class to **sync** that scope from AEC Data Model. One fetch powers both **Model / Data Overview** (class breakdown with drill-down) and **Element Quality**.
- **Completeness** and **Validity** use the bundled `.dcf` for the data set kind (`ProcessPower.dcf` for P&ID, `Piping.dcf` for 3D). Click a quality bar to list affected elements.
- **Reconciliation** compares **Tag** (and **Spec**, **Status**, **Area**) between the paired P&ID and 3D data sets after you **⟳ sync overlapping scope on both sides** (for example **Engineering Items** or **Equipment** on each). It does **not** match on PnPId — 2D and 3D use separate id spaces by design. Click the **Reconciliation** bar for P&ID-only, 3D-only, and attribute-mismatch rows.
- On P&ID, **⟳ Sync Engineering Items** before **Relationship**, then open the engineering items table and select a row to view **pairs** by PnPId within the P&ID data set.

Listing and sync permissions follow the signed-in user’s ACC/AEC Data Model access. Empty Plant 3D trees usually mean missing data set names, wrong folder scope, or no Plant 3D content synced to AEC Data Model.

## Debug

Use [.vscode/launch.json](.vscode/launch.json) from the **Run and Debug** panel in VS Code or Cursor:

| Configuration | Purpose |
| --- | --- |
| **Launch server** | Starts the app with `.env`, opens the dashboard when the server is ready |
| **Launch server (verbose)** | Same, plus `DEBUG=app:*` and `ENABLE_DEBUG_ENDPOINTS=true` |
| **Launch server (watch + verbose)** | Restarts on server file changes; good default for backend work |
| **Attach to running server** | Attach after `npm run debug` (inspector on port **9229**) |
| **Debug front end (Chrome)** | Debug `public/` JS against the running app — set the `url` port to match `PORT` in `.env` (default **8080**) |
| **Full stack (server + browser)** | Compound: watch server + Chrome |

From a terminal you can run `npm run dev` (auto-restart) or `npm run debug` (inspect, then attach). Server logs use the `DEBUG` env var ([server/logger.js](server/logger.js)): `app:http`, `app:auth`, `app:graphql`, `app:dm`, `app:plant3d`, or `app:*`. For an empty Plant 3D tree, `DEBUG=app:plant3d` is usually enough.

With `ENABLE_DEBUG_ENDPOINTS=true` (included in the verbose launch configs), signed-in users can call local-only helpers under `/api/debug/*`: `GET /session`, `GET /token`, `POST /graphql` (AEC Data Model proxy), `GET /dm?path=…` (Data Management proxy). Do not enable this in production.

### Plant 3D data sets

The dashboard looks for these **AEC Data Model element group** names when it scans a Plant 3D project. The **Role** column also shows which bundled **`.dcf` schema** under [server/schemas/](server/schemas/) drives **Completeness** and **Validity** for that data set (reference only — property values still come from live GraphQL sync).

| Element group name | Role |
| --- | --- |
| `P&ID Data Set` | 2D P&ID (`ProcessPower.dcf`) |
| `3D Piping Data Set` | 3D piping model (`Piping.dcf`) |
| `3D Models Data Set` | Treated as a 3D piping data set for pairing and `kind=3d` sync (`Piping.dcf`) |

Additional element group names can be added in `PLANT3D_DATASET_NAMES` in [server/config.js](server/config.js).

To explore a `.dcf` class hierarchy offline (requires `sqlite3` or Node `node:sqlite` — see [Prerequisites](#prerequisites)):

```sh
npm run schema:dump -- server/schemas/ProcessPower.dcf --tree
npm run schema:dump -- server/schemas/Piping.dcf --tree
```

Add a second argument to write JSON to a file, or omit `--tree` to print JSON to stdout (see [server/schemas/dump.js](server/schemas/dump.js)).
 

### Security and sample limits

- OAuth uses the APS SDK with authorization code flow; tokens are stored **server-side** in the session and refreshed when near expiry. Client secrets are never sent to the browser.
- Sessions use the default in-memory store and a signed cookie (`SERVER_SESSION_SECRET`). **Restarting the server signs everyone out** and clears sync/quality caches.
- Sync results, quality scores, and reconciliation are **in-memory** per server process. Drill-down after sync does not call APS again until you run a new **⟳** sync.
- With `ENABLE_DEBUG_ENDPOINTS=true`, `/api/debug/*` exposes the session access token and GraphQL helpers — **local development only**.
- AEC Data Model is **rate limited** (GraphQL point budget). Large element groups may require several pages; prefer **folder** scan mode and **narrow class scope** syncs on big projects.
- **Engineering Items sync can take a long time** on large models. Plant 3D exposes each element’s class ancestry in the **Table Names** property as a comma-separated chain (leaf through ancestors), e.g. a P&ID gate valve: `GateValve,HandValves,InLineAssets,EngineeringItems`. Sync scope uses `=contains=` on that value, which is a plain substring match — so filtering for `EngineeringItems` would also match `NonEngineeringItems`. The AEC filter language cannot express “contains `EngineeringItems` but not `NonEngineeringItems`”, so this sample **does not** apply a narrow server filter for the **Engineering Items** or **Non Engineering Items** branches ([server/schemas/index.js](server/schemas/index.js), [server/overview.js](server/overview.js)). It pages a **broad fetch** (often the whole element group, including system tables), then keeps the requested branch with an in-memory `inScope` pass. Prefer **⟳** on a **deeper class** (Equipment, Hand Valves, …) when you only need that subtree.
- Bundled `.dcf` files are **schema references** only; element property values always come from live AEC Data Model queries.
- **AEC Data Model pricing:** AEC usage is billed mainly on **Data Out**, with included monthly capacity on qualifying subscriptions ([overview](https://aps.autodesk.com/blog/data-model-apis-included-subscriptions-plus-flexible-ways-scale)). This sample’s broad **⟳** sync suits demos; for production, use narrower queries and the [GraphQL best practices](https://aps.autodesk.com/blog/aec-data-model-api-best-practices-under-new-pricing-model-practical-graphql-patterns).

Before production deployment, use a persistent session store, durable caching strategy, HTTPS, secret management, and monitoring. Do not treat this sample’s in-memory design as production-ready.

### Troubleshooting

- **Empty hubs or projects** — confirm account/project membership and that the hub is visible to AEC Data Model.
- **Empty Plant 3D tree after folder scan** — run with `DEBUG=app:plant3d` and check rejected element group names; verify data set naming and `PLANT3D_DATASET_NAMES`.
- **409 Not synced yet** on rollup/quality — run **⟳** on the same class scope first.
- **Reconciliation shows n/a** — sync the **paired** data set at overlapping scope; confirm **Reconciliation pair** in data set details.
- **Reconciliation 0% with tags present** — tags may not match across P&ID and 3D, or **Spec** / **Status** / **Area** differ; use the Reconciliation issue table.
- **Relationship table empty** — sync **Engineering Items** on P&ID before syncing **Relationship**.
- **Validity/completeness look wrong for 3D** — confirm sync ran on **3D Piping Data Set** (uses `Piping.dcf`, not `ProcessPower.dcf`).

### Additional links

- [AEC Data Model API documentation](https://aps.autodesk.com/en/docs/aecdatamodel/v1)
- [Query AutoCAD Plant 3D Project Data](https://aps.autodesk.com/en/docs/aecdatamodel/v1/tutorials/plant3d/)
- [AutoCAD Plant 3D toolset](https://www.autodesk.com/products/autocad/included-toolsets/autocad-plant-3d) 


## Disclaimer

This sample application was developed with AI-assisted tooling to demonstrate **Autodesk Platform Services (APS)** and the **AEC Data Model** with **AutoCAD Plant 3D** P&ID and 3D piping data sets—3-legged OAuth, data set discovery, class overview, element quality, tag reconciliation, and relationship pairing. It is provided **as-is** for learning and demonstration only.

Reasonable care was taken to align behavior with the public AEC Data Model documentation and Plant 3D data model concepts, but the code has **not** been validated for production use. Before relying on it in any live environment, perform your own **security review**, **error-handling and resilience checks**, and **end-to-end testing** with your APS app, ACC project, and Plant 3D content. **Use at your own risk.**

## License

This sample is licensed under the [MIT License](https://opensource.org/licenses/MIT). See the [LICENSE](LICENSE) file in this repository.
