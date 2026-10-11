/**
 * Engineering-items table with its paired-elements panel.
 *
 * Rows come from `engineering_items_overview_data` — the Engineering Items sync
 * — 50 per page. Clicking a row looks the element up in `relationship_data` and
 * lists whatever it is paired with.
 */
const itemsTable = (() => {
  const COLUMNS = [
    ['pnpId', 'PnP ID'],
    ['className', 'Class Name'],
    ['tag', 'Tag'],
    ['area', 'Area'],
    ['status', 'Status'],
    ['description', 'Description'],
  ];

  const cell = (v) => (v === null || v === undefined || v === '' ? '—' : v);

  let selectedRow = null;

  /**
   * Splits the panel into two stacked halves:
   *
   *   top    — the item table and the pair panel, side by side, scrolling
   *   bottom — the schematic, full width
   *
   * The halves are fixed at 50% of the viewport each so the schematic always
   * has room, rather than being pushed off-screen by a 50-row table.
   */
  function shell(container, total, storedAt) {
    container.innerHTML = '';

    const view = document.createElement('div');
    view.className = 'items-view';

    const top = document.createElement('div');
    top.className = 'items-top';

    const title = document.createElement('h2');
    title.textContent = 'Engineering Items Relationship';
    top.append(title);

    const sub = document.createElement('p');
    sub.className = 'crumb-meta';
    sub.textContent =
      `${total.toLocaleString()} item${total === 1 ? '' : 's'} from engineering_items_overview_data` +
      (storedAt ? ` · synced ${new Date(storedAt).toLocaleTimeString()}` : '') +
      ' · click a row to see what it is paired with';
    top.append(sub);

    const split = document.createElement('div');
    split.className = 'items-split';
    const left = document.createElement('div');
    left.className = 'items-main';
    const right = document.createElement('div');
    right.className = 'items-pairs';
    split.append(left, right);
    top.append(split);

    // The schematic gets the whole bottom half — its own card, not part of the
    // pair panel, which is far too narrow to draw in.
    const diagram = document.createElement('section');
    diagram.className = 'schematic-section';

    view.append(top, diagram);
    container.append(view);

    return { left, right, diagram };
  }

  function renderPager(host, page, pages, total, onPage) {
    const bar = document.createElement('div');
    bar.className = 'pager';

    const mk = (text, target, disabled) => {
      const b = document.createElement('button');
      b.className = 'ghost-button';
      b.textContent = text;
      b.disabled = disabled;
      if (!disabled) b.addEventListener('click', () => onPage(target));
      return b;
    };

    const label = document.createElement('span');
    label.className = 'pager-label';
    label.textContent = `Page ${page} of ${pages} · ${total.toLocaleString()} items`;

    bar.append(mk('‹ Prev', page - 1, page <= 1), label, mk('Next ›', page + 1, page >= pages));
    host.append(bar);
  }

  /** Placeholder shown in the pair panel until a row is picked. */
  function pairHint(host, text) {
    host.innerHTML = '';
    const heading = document.createElement('h3');
    heading.textContent = 'Paired elements';
    const hint = document.createElement('p');
    hint.className = 'muted';
    hint.textContent = text;
    host.append(heading, hint);
  }

  /**
   * @param {HTMLElement} container
   * @param {object} result   { rows, page, pages, total, storedAt }
   * @param {object} handlers { onPage(n), onRow(row, pairHost) }
   */
  function render(container, result, handlers = {}) {
    selectedRow = null;
    const { left, right, diagram: diagramHost } = shell(container, result.total, result.storedAt);

    const table = document.createElement('table');
    table.className = 'issue-table items-table';

    const head = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const [, label] of COLUMNS) {
      const th = document.createElement('th');
      th.textContent = label;
      hr.append(th);
    }
    head.append(hr);

    const body = document.createElement('tbody');
    for (const row of result.rows) {
      const tr = document.createElement('tr');
      tr.className = 'clickable';
      for (const [field] of COLUMNS) {
        const td = document.createElement('td');
        td.textContent = cell(row[field]);
        tr.append(td);
      }
      tr.addEventListener('click', () => {
        if (selectedRow) selectedRow.classList.remove('selected');
        tr.classList.add('selected');
        selectedRow = tr;
        if (handlers.onRow) handlers.onRow(row, { pairHost: right, diagramHost });
      });
      body.append(tr);
    }

    table.append(head, body);
    left.append(table);
    renderPager(left, result.page, result.pages, result.total, handlers.onPage || (() => {}));

    pairHint(right, 'Select a row on the left.');
    diagramHint(diagramHost, 'Select a row to draw its relationships.');
    return { pairHost: right, diagramHost };
  }

  /** Placeholder for the schematic card. */
  function diagramHint(host, text) {
    host.innerHTML = '';
    const heading = document.createElement('h3');
    heading.textContent = 'Schematic';
    const hint = document.createElement('p');
    hint.className = 'muted';
    hint.textContent = text;
    host.append(heading, hint);
  }

  /** The paired elements of one item. */
  function renderPairs(host, row, result) {
    host.innerHTML = '';

    const heading = document.createElement('h3');
    heading.textContent = 'Paired elements';
    host.append(heading);

    const who = document.createElement('p');
    who.className = 'crumb-meta';
    who.textContent = `${row.className || '(unknown class)'} · PnP ID ${row.pnpId}`;
    host.append(who);

    if (!result.pairs.length) {
      const none = document.createElement('p');
      none.className = 'muted';
      none.textContent = 'No relationships reference this element.';
      host.append(none);
      return;
    }

    const table = document.createElement('table');
    table.className = 'issue-table';

    const head = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const label of ['PnP ID', 'Class Name', 'Tag', 'Via']) {
      const th = document.createElement('th');
      th.textContent = label;
      hr.append(th);
    }
    head.append(hr);

    const body = document.createElement('tbody');
    for (const pair of result.pairs) {
      const tr = document.createElement('tr');
      for (const value of [
        pair.pnpId,
        // Unresolved means the partner is not an engineering item (or the
        // Engineering Items sync has not run), so show the endpoint role.
        pair.className || `(${pair.role})`,
        pair.tag,
        pair.via,
      ]) {
        const td = document.createElement('td');
        td.textContent = cell(value);
        tr.append(td);
      }
      body.append(tr);
    }

    table.append(head, body);
    host.append(table);
  }

  /* ---------- schematic ---------- */

  let diagram = null;

  /**
   * Symbol per class family, chosen from the ancestry rather than guessed from
   * the class name.
   *
   * These are readable glyphs, NOT real P&ID symbols — there are 709 classes and
   * no symbol library here, so anything unrecognised falls back to a rounded
   * box. The intent is "you can tell a tank from a line at a glance".
   */
  /**
   * Glyphs per class family, drawn as SVG paths in a 0..24 box that ECharts
   * scales to symbolSize. Loosely P&ID-flavoured — a bowtie for valves, a
   * pedestal circle for pumps, a dished vessel for tanks — but NOT a real
   * symbol library: 709 classes fall back to a rounded box.
   */
  const GLYPH = {
    // Vertical vessel with dished ends.
    vessel: 'path://M3,6 Q3,1 12,1 Q21,1 21,6 L21,18 Q21,23 12,23 Q3,23 3,18 Z',
    // Centrifugal pump: circle on a pedestal.
    pump: 'path://M3,13 A9,9 0 1,1 21,13 L24,13 L24,22 L0,22 L0,13 Z',
    // Gate valve: the classic bowtie.
    valve: 'path://M1,3 L12,12 L1,21 Z M23,3 L12,12 L23,21 Z',
    // Concentric reducer: trapezoid.
    reducer: 'path://M2,5 L22,9 L22,15 L2,19 Z',
    // Nozzle: a stub with a flange plate.
    nozzle: 'path://M0,8 L14,8 L14,3 L19,3 L19,21 L14,21 L14,16 L0,16 Z',
    // Off-page connector: home-plate pentagon.
    connector: 'path://M1,4 L15,4 L23,12 L15,20 L1,20 Z',
  };

  function symbolFor(ancestry) {
    const has = (name) => (ancestry || []).indexOf(name) >= 0;
    if (has('Tanks')) return { symbol: GLYPH.vessel, size: [30, 34] };
    if (has('Pumps')) return { symbol: GLYPH.pump, size: [32, 28] };
    if (has('HeatExchangers')) return { symbol: 'rect', size: [40, 24] };
    if (has('Compressors') || has('Blowers')) return { symbol: 'circle', size: 30 };
    if (has('HandValves') || has('ReliefValves') || has('ControlValves')) {
      return { symbol: GLYPH.valve, size: [30, 22] };
    }
    if (has('Reducers')) return { symbol: GLYPH.reducer, size: [30, 22] };
    if (has('Nozzles')) return { symbol: GLYPH.nozzle, size: [24, 22] };
    if (has('Lines')) return { symbol: 'rect', size: [46, 10] };
    if (has('Instrumentation')) return { symbol: 'circle', size: 28 };
    if (has('Connectors')) return { symbol: GLYPH.connector, size: [28, 24] };
    if (has('PipingFittings') || has('PipingSpecialtyItems')) {
      return { symbol: 'roundRect', size: [26, 20] };
    }
    return { symbol: 'roundRect', size: [38, 26] };
  }

  /**
   * Two lines under each node: the tag, then class · spec · id.
   *
   * An unresolved pair has no tag or class, so the id becomes the headline —
   * the second line then drops it rather than printing it twice, and names the
   * endpoint role instead.
   */
  function nodeLabel(item) {
    const head = item.tag || item.className || `#${item.pnpId}`;
    const kind = item.className || (item.role ? `(${item.role})` : null);
    const detail = [kind, item.spec, `#${item.pnpId}`]
      .filter(Boolean)
      .filter((bit) => bit !== head)
      .join(' · ');
    return detail ? `${head}\n${detail}` : head;
  }

  // Fixed drawing box. Positions are plotted on a hidden cartesian grid rather
  // than left to the graph layout's auto-fit: with one or two pairs every node
  // sits at x=0, the bounding box has zero width, and the auto-fit collapses —
  // symbols vanish off-canvas while the labels still draw.
  const BOX = { x: 150, y: 105 };

  /**
   * A star schematic: the selected element in the middle, its pairs around it,
   * each edge labelled with the relationship type.
   */
  function renderDiagram(host, row, result) {
    if (diagram) {
      diagram.dispose();
      diagram = null;
    }
    host.innerHTML = '';

    const heading = document.createElement('h3');
    heading.textContent = 'Schematic';
    host.append(heading);

    const who = document.createElement('p');
    who.className = 'crumb-meta';
    who.textContent = `${row.tag || row.className || '#' + row.pnpId} and its ${
      result.pairs.length
    } relationship${result.pairs.length === 1 ? '' : 's'}`;
    host.append(who);

    if (!result.pairs.length) {
      const none = document.createElement('p');
      none.className = 'muted';
      none.textContent = 'Nothing to draw — this element has no relationships.';
      host.append(none);
      return;
    }

    // Height comes from the bottom half of the panel, not from the pair count.
    const canvas = document.createElement('div');
    canvas.className = 'schematic';
    host.append(canvas);

    const centre = symbolFor(row.ancestry);
    const nodes = [
      {
        name: `c:${row.pnpId}`,
        value: [0, 0],
        symbol: centre.symbol,
        symbolSize: centre.size,
        itemStyle: { color: '#0696d7', borderColor: '#05506f', borderWidth: 1 },
        label: { fontWeight: 700 },
        _item: row,
      },
    ];
    const links = [];

    const step = (Math.PI * 2) / result.pairs.length;
    // Off-axis start angle so two pairs still spread horizontally.
    const offset = result.pairs.length <= 2 ? Math.PI : -Math.PI / 2;
    const rx = BOX.x * 0.7;
    const ry = BOX.y * 0.62;

    result.pairs.forEach((pair, i) => {
      const sym = symbolFor(pair.ancestry);
      const angle = offset + i * step;
      nodes.push({
        name: `p:${i}:${pair.pnpId}`,
        value: [Math.cos(angle) * rx, Math.sin(angle) * ry],
        symbol: sym.symbol,
        symbolSize: sym.size,
        itemStyle: {
          color: pair.resolved ? '#12a594' : '#c9ced4',
          borderColor: '#3f4b57',
          borderWidth: 1,
        },
        _item: pair,
      });
      links.push({ source: `c:${row.pnpId}`, target: `p:${i}:${pair.pnpId}`, value: pair.via });
    });

    diagram = echarts.init(canvas);
    diagram.setOption({
      animation: false,
      grid: { left: 78, right: 78, top: 26, bottom: 44 },
      xAxis: { type: 'value', min: -BOX.x, max: BOX.x, show: false },
      yAxis: { type: 'value', min: -BOX.y, max: BOX.y, show: false },
      tooltip: {
        formatter: (p) => {
          if (p.dataType === 'edge') return `via <b>${p.data.value}</b>`;
          const it = p.data._item;
          return (
            `<b>${it.tag || '(no tag)'}</b><br/>${it.className || '(' + it.role + ')'}<br/>` +
            `PnP ID ${it.pnpId}${it.spec ? '<br/>Spec ' + it.spec : ''}` +
            (it.via ? `<br/><i>via ${it.via}</i>` : '')
          );
        },
      },
      series: [
        {
          type: 'graph',
          coordinateSystem: 'cartesian2d',
          data: nodes,
          links,
          lineStyle: { color: '#8a9098', width: 1.4, curveness: 0 },
          edgeLabel: {
            show: true,
            formatter: (p) => p.data.value,
            fontSize: 9,
            color: '#6b7280',
          },
          label: {
            show: true,
            position: 'bottom',
            distance: 7,
            fontSize: 10,
            lineHeight: 13,
            color: '#1a1d21',
            formatter: (p) => nodeLabel(p.data._item),
          },
          emphasis: { focus: 'adjacency' },
        },
      ],
    });
  }

  const resizeDiagram = () => diagram && diagram.resize();
  window.addEventListener('resize', resizeDiagram);

  return { render, renderPairs, renderDiagram, pairHint, diagramHint };
})();
