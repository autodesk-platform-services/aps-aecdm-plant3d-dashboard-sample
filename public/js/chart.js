/**
 * Overview chart: a horizontal bar per class with the count printed at the end
 * of the bar, plus a KPI strip above it.
 *
 * Clicking a drillable bar calls onDrill(bucket) so the caller can regroup one
 * level deeper.
 */
const overviewChart = (() => {
  let instance = null;

  // Muted greys with one accent, so the bars read as data rather than decoration.
  const BAR = '#3f4b57';
  const BAR_DRILLABLE = '#0696d7';

  const fmt = (n) => n.toLocaleString();

  function renderKpis(container, result, crumbs) {
    const strip = document.createElement('div');
    strip.className = 'kpi-strip';

    const scope = crumbs.length ? crumbs[crumbs.length - 1].label : 'In scope';
    const other = result.total - result.matched;

    // The in-scope count leads, because that is the number that matches what
    // Plant 3D shows. "Elements in data set" is much larger: AEC Data Model
    // returns a row of every PnP table as an element, including the system
    // tables this UI hides (PnPDrawings, PnPTagRegistry, PnPGeometry, …).
    const kpis = [
      [scope, fmt(result.matched), `Elements whose class sits under ${scope}`],
      ['Sub-classes', fmt(result.buckets.length), 'Distinct classes one level down'],
    ];

    if (result.filtered) {
      // The fetch was narrowed server-side, so `total` is the filtered count.
      // Presenting it as the data-set total would be wrong.
      kpis.push([
        'Fetched',
        fmt(result.total),
        `Narrowed server-side to '${result.filtered}' over ${fmt(result.pages)} page(s), ` +
          'so this is not the whole data set.',
      ]);
    } else {
      kpis.push(
        [
          'Other classes',
          fmt(other),
          'Elements elsewhere in the data set — other branches plus Plant 3D ' +
            'system tables. Not shown in this chart.',
        ],
        [
          'Elements in data set',
          fmt(result.total),
          `Everything the element group returned, across ${fmt(result.pages)} page(s)`,
        ],
      );
    }

    for (const [label, value, tip] of kpis) {
      const cell = document.createElement('div');
      cell.className = 'kpi';
      if (tip) cell.title = tip;
      const v = document.createElement('span');
      v.className = 'kpi-value';
      v.textContent = value;
      const l = document.createElement('span');
      l.className = 'kpi-label';
      l.textContent = label;
      cell.append(v, l);
      strip.append(cell);
    }
    container.append(strip);
  }

  function renderBreadcrumbs(container, crumbs, onCrumb) {
    if (crumbs.length < 2) return;
    const nav = document.createElement('div');
    nav.className = 'crumbs';
    crumbs.forEach((crumb, i) => {
      if (i) {
        const sep = document.createElement('span');
        sep.className = 'crumb-sep';
        sep.textContent = '›';
        nav.append(sep);
      }
      if (i === crumbs.length - 1) {
        const here = document.createElement('span');
        here.className = 'crumb current';
        here.textContent = crumb.label;
        nav.append(here);
      } else {
        const link = document.createElement('button');
        link.className = 'crumb';
        link.textContent = crumb.label;
        link.addEventListener('click', () => onCrumb(i));
        nav.append(link);
      }
    });
    container.append(nav);
  }

  /**
   * @param {HTMLElement} container  cleared and rebuilt
   * @param {object} result          { buckets, total, matched, pages, path, syncedAt }
   * @param {Array}  crumbs          [{ tableName, label }] root-first, for the trail
   * @param {object} handlers        { onDrill(bucket), onCrumb(index) }
   */
  function render(container, result, crumbs, handlers = {}) {
    if (instance) {
      instance.dispose();
      instance = null;
    }
    container.innerHTML = '';

    const title = document.createElement('h2');
    title.textContent = 'Model / Data Overview';
    container.append(title);

    if (result.syncedAt) {
      const sub = document.createElement('p');
      sub.className = 'crumb-meta';
      sub.textContent = `${result.cached ? 'Regrouped from' : 'Synced'} ${new Date(
        result.syncedAt,
      ).toLocaleTimeString()}${result.unclassified ? ` · ${result.unclassified} unclassified` : ''}`;
      container.append(sub);
    }

    renderBreadcrumbs(container, crumbs, handlers.onCrumb || (() => {}));
    renderKpis(container, result, crumbs);

    if (!result.buckets.length) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = 'No elements under this class.';
      container.append(empty);
      return;
    }

    const canvas = document.createElement('div');
    canvas.className = 'chart';
    // 34px per bar keeps labels legible however many classes come back.
    canvas.style.height = `${Math.max(180, result.buckets.length * 34 + 40)}px`;
    container.append(canvas);

    // ECharts draws a category axis bottom-up, so reverse for descending order.
    const ordered = [...result.buckets].reverse();

    instance = echarts.init(canvas);
    instance.setOption({
      grid: { left: 8, right: 72, top: 8, bottom: 8, containLabel: true },
      xAxis: { type: 'value', splitLine: { lineStyle: { color: '#eceef1' } }, axisLabel: { show: false } },
      yAxis: {
        type: 'category',
        data: ordered.map((b) => b.label),
        axisTick: { show: false },
        axisLine: { show: false },
        axisLabel: { color: '#1a1d21', fontSize: 12 },
      },
      tooltip: {
        trigger: 'item',
        formatter: (p) => {
          const b = ordered[p.dataIndex];
          return `<b>${b.label}</b><br/>${b.tableName}<br/>${fmt(b.count)} · ${b.percent}%${
            b.drillable ? '<br/><i>click to drill down</i>' : ''
          }`;
        },
      },
      series: [
        {
          type: 'bar',
          data: ordered.map((b) => ({
            value: b.count,
            itemStyle: { color: b.drillable ? BAR_DRILLABLE : BAR, borderRadius: [0, 2, 2, 0] },
          })),
          barMaxWidth: 18,
          cursor: 'pointer',
          label: {
            show: true,
            position: 'right',
            formatter: (p) => `${fmt(p.value)}   ${ordered[p.dataIndex].percent}%`,
            color: '#1a1d21',
            fontSize: 12,
          },
        },
      ],
    });

    instance.on('click', (params) => {
      const bucket = ordered[params.dataIndex];
      if (bucket && bucket.drillable && handlers.onDrill) handlers.onDrill(bucket);
    });
  }

  /** ECharts needs an explicit resize when its container changes size. */
  const resize = () => instance && instance.resize();
  window.addEventListener('resize', resize);

  return { render, resize };
})();

/**
 * Quality chart: one bar per metric with the score printed at the end.
 * Clicking an implemented metric calls onSelect(metric) so the caller can show
 * the offending elements. Reconciliation stays grey until both data sets are
 * synced at the same scope.
 */
const qualityChart = (() => {
  let instance = null;

  // One hue per metric so the two bars are never confused with each other.
  // Distinct in hue AND lightness, so they still separate in greyscale.
  const METRIC_COLOR = {
    completeness: '#0696d7', // blue
    validity: '#12a594', // teal
    reconciliation: '#e67e22', // orange
  };
  const NOT_IMPLEMENTED = '#c9ced4';

  /**
   * Builds the two-column shell: chart on the left, issue table on the right.
   * Returns the two hosts so the caller can fill them independently.
   */
  function shell(container, subtitle) {
    container.innerHTML = '';

    const title = document.createElement('h2');
    title.textContent = 'Element Quality';
    container.append(title);

    const sub = document.createElement('p');
    sub.className = 'crumb-meta';
    sub.textContent = subtitle;
    container.append(sub);

    const split = document.createElement('div');
    split.className = 'quality-split';
    const left = document.createElement('div');
    left.className = 'quality-chart';
    const right = document.createElement('div');
    right.className = 'quality-issues';
    split.append(left, right);
    container.append(split);

    return { left, right };
  }

  /**
   * While the overview sync is running the quality card shows a bare status
   * line — no heading, no explanation, no columns. Anything more competes with
   * the overview for attention while there is nothing to act on.
   */
  function renderStatus(container, text) {
    if (instance) {
      instance.dispose();
      instance = null;
    }
    container.innerHTML = '';

    const line = document.createElement('p');
    line.className = 'muted quality-status';

    const spinner = document.createElement('span');
    spinner.className = 'spinner';
    const label = document.createElement('span');
    label.textContent = ` ${text}`;

    line.append(spinner, label);
    container.append(line);
  }

  /** Overview is still paging — quality has nothing to work on yet. */
  const renderStandby = (container) => renderStatus(container, 'Element quality: waiting…');

  /** Paging finished; walking every property of every fetched element. */
  const renderPending = (container, elementCount, message) =>
    renderStatus(
      container,
      elementCount
        ? `${message || 'Checking element quality'} — ${elementCount.toLocaleString()} elements…`
        : message || 'Checking element quality…',
    );

  function render(container, result, handlers = {}) {
    if (instance) {
      instance.dispose();
      instance = null;
    }

    const { left, right } = shell(
      container,
      `${result.elements.toLocaleString()} element${result.elements === 1 ? '' : 's'} assessed` +
        ` · from the same fetch as the overview (${result.pages} page(s))` +
        ` · click a bar for the element list`,
    );

    const canvas = document.createElement('div');
    canvas.className = 'chart';
    canvas.style.height = `${result.metrics.length * 38 + 24}px`;
    left.append(canvas);

    // Reversed: ECharts builds a category axis bottom-up.
    const ordered = [...result.metrics].reverse();

    instance = echarts.init(canvas);
    instance.setOption({
      // Bars are deliberately short — the table takes the right-hand column, and
      // the score is printed beside each bar rather than read off an axis.
      grid: { left: 8, right: 96, top: 6, bottom: 6, containLabel: true },
      xAxis: {
        type: 'value',
        max: 100,
        splitLine: { lineStyle: { color: '#eceef1' } },
        axisLabel: { show: false },
      },
      yAxis: {
        type: 'category',
        data: ordered.map((m) => m.label),
        axisTick: { show: false },
        axisLine: { show: false },
        axisLabel: { color: '#1a1d21', fontSize: 12 },
      },
      tooltip: {
        trigger: 'item',
        formatter: (p) => {
          const m = ordered[p.dataIndex];
          if (!m.implemented) return `<b>${m.label}</b><br/>${m.note}`;
          return (
            `<b>${m.label}</b> — ${m.percent}%<br/>` +
            `${m.failed.toLocaleString()} of ${m.checked.toLocaleString()} checks failed<br/>` +
            `${m.affected.toLocaleString()} element(s) affected<br/><i>${m.note}</i>`
          );
        },
      },
      series: [
        {
          type: 'bar',
          data: ordered.map((m) => ({
            // A placeholder metric still needs a slot, so draw a zero-width bar.
            value: m.implemented && m.percent !== null ? m.percent : 0,
            itemStyle: {
              color:
                m.implemented && m.percent !== null
                  ? METRIC_COLOR[m.key] || METRIC_COLOR.completeness
                  : NOT_IMPLEMENTED,
              borderRadius: [0, 2, 2, 0],
            },
          })),
          barMaxWidth: 16,
          cursor: 'pointer',
          label: {
            show: true,
            position: 'right',
            color: '#1a1d21',
            fontSize: 12,
            formatter: (p) => {
              const m = ordered[p.dataIndex];
              if (!m.implemented) return 'n/a';
              if (m.percent === null) return '—';
              return `${m.percent}%`;
            },
          },
        },
      ],
    });

    // Legend of failure counts under the chart — the numbers no longer fit
    // beside the shortened bars.
    const legend = document.createElement('ul');
    legend.className = 'metric-legend';
    for (const m of result.metrics) {
      const li = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = 'swatch';
      dot.style.background = m.implemented ? METRIC_COLOR[m.key] : NOT_IMPLEMENTED;
      const text = document.createElement('span');
      text.textContent = m.implemented
        ? `${m.label}: ${m.failed.toLocaleString()} of ${m.checked.toLocaleString()} failed · ${m.affected.toLocaleString()} elements`
        : `${m.label}: ${m.note || 'not available'}`;
      li.append(dot, text);
      legend.append(li);
    }
    left.append(legend);

    const placeholder = document.createElement('p');
    placeholder.className = 'muted';
    placeholder.textContent =
      'Click Completeness, Validity, or Reconciliation to list the elements.';
    right.append(placeholder);

    instance.on('click', (params) => {
      const metric = ordered[params.dataIndex];
      if (metric && metric.implemented && handlers.onSelect) handlers.onSelect(metric, right);
    });

    return { issuesHost: right };
  }

  const RECON_KIND_LABEL = {
    pid_only: 'P&ID only',
    model_only: '3D only',
    mismatch: 'Attribute mismatch',
    duplicate_pid: 'Duplicate tag (P&ID)',
    duplicate_3d: 'Duplicate tag (3D)',
  };

  function kindLabel(kind) {
    return RECON_KIND_LABEL[kind] || kind || '—';
  }

  /** Table of offending elements: area, PnP ID, class, and the fields at fault. */
  function renderIssues(container, metric, rows) {
    container.innerHTML = '';

    const heading = document.createElement('h3');
    heading.textContent = `${metric.label} — ${rows.length.toLocaleString()} element${
      rows.length === 1 ? '' : 's'
    }`;
    container.append(heading);

    if (!rows.length) {
      const ok = document.createElement('p');
      ok.className = 'muted';
      ok.textContent = 'No issues found in this scope.';
      container.append(ok);
      return;
    }

    const table = document.createElement('table');
    table.className = 'issue-table';

    const head = document.createElement('thead');
    const hr = document.createElement('tr');
    if (metric.key === 'reconciliation') {
      for (const label of ['Tag', 'Issue', 'P&ID class', '3D class', 'Detail']) {
        const th = document.createElement('th');
        th.textContent = label;
        hr.append(th);
      }
    } else {
      const fieldsHeader =
        metric.key === 'completeness' ? 'Fields with missing values' : 'Fields with wrong values';
      for (const label of ['Area', 'PnP ID', 'Class Name', fieldsHeader]) {
        const th = document.createElement('th');
        th.textContent = label;
        hr.append(th);
      }
    }
    head.append(hr);

    const body = document.createElement('tbody');
    for (const row of rows) {
      const tr = document.createElement('tr');
      const cells =
        metric.key === 'reconciliation'
          ? [row.tag, kindLabel(row.kind), row.pidClass, row.p3dClass, row.fields]
          : [row.area, row.pnpId, row.className, row.fields];
      for (const value of cells) {
        const td = document.createElement('td');
        td.textContent = value === null || value === undefined || value === '' ? '—' : value;
        tr.append(td);
      }
      body.append(tr);
    }

    table.append(head, body);
    container.append(table);
  }

  const resize = () => instance && instance.resize();
  window.addEventListener('resize', resize);

  return { render, renderStandby, renderPending, renderStatus, renderIssues, resize };
})();
