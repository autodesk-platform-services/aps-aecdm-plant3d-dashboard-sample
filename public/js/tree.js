/* Minimal lazy-loading tree. A node is:
   { label, icon, data, loadChildren?: () => Promise<node[]>, onSelect?: (node) => void } */
const tree = (() => {
  let selectedRow = null;

  function createNode(spec) {
    const node = document.createElement('div');
    node.className = 'node';

    const row = document.createElement('div');
    row.className = 'node-row';

    const caret = document.createElement('span');
    caret.className = spec.loadChildren ? 'caret' : 'caret leaf';
    caret.textContent = '▶';

    const icon = document.createElement('span');
    icon.className = 'node-icon';
    icon.textContent = spec.icon || '';

    const label = document.createElement('span');
    label.className = 'node-label';
    label.textContent = spec.label;
    label.title = spec.label;

    row.append(caret, icon, label);

    if (spec.hint) {
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = spec.hint;
      row.append(hint);
    }

    // An inline button (e.g. sync). stopPropagation keeps it from toggling the row.
    if (spec.action) {
      const button = document.createElement('button');
      button.className = 'row-action';
      button.title = spec.action.title || '';
      // The glyph lives in its own span so the spin animation rotates only the
      // icon — animating the button would spin its border and background too.
      const glyph = document.createElement('span');
      glyph.className = 'row-action-icon';
      glyph.textContent = spec.action.icon;
      button.append(glyph);
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        spec.action.onClick(button);
      });
      row.append(button);
    }

    const children = document.createElement('div');
    children.className = 'node-children hidden';

    node.append(row, children);

    let loaded = false;
    let open = false;

    async function toggle() {
      if (!spec.loadChildren) return;
      open = !open;
      caret.classList.toggle('open', open);
      children.classList.toggle('hidden', !open);
      if (open && !loaded) {
        loaded = true;

        // Loading placeholder, with a label the loader can update as it goes.
        children.innerHTML = '';
        const status = document.createElement('p');
        status.className = 'muted pad status';
        const spinner = document.createElement('span');
        spinner.className = 'spinner';
        const statusText = document.createElement('span');
        statusText.textContent = ' Loading…';
        status.append(spinner, statusText);
        children.append(status);

        const setStatus = (text) => {
          statusText.textContent = ` ${text}`;
        };

        try {
          const specs = await spec.loadChildren(setStatus);
          children.innerHTML = '';
          if (!specs.length) {
            children.innerHTML = '<p class="muted pad">Nothing found.</p>';
            return;
          }
          specs.forEach((child) => children.append(createNode(child)));
        } catch (err) {
          loaded = false; // let the user retry by collapsing and reopening
          children.innerHTML = '';
          const msg = document.createElement('p');
          msg.className = 'error pad';
          msg.textContent = err.message;
          children.append(msg);
        }
      }
    }

    row.addEventListener('click', () => {
      if (selectedRow) selectedRow.classList.remove('selected');
      row.classList.add('selected');
      selectedRow = row;
      if (spec.onSelect) spec.onSelect(spec);
      toggle();
    });

    return node;
  }

  function render(container, specs) {
    container.innerHTML = '';
    selectedRow = null;
    if (!specs.length) {
      container.innerHTML = '<p class="muted pad">Nothing found.</p>';
      return;
    }
    specs.forEach((spec) => container.append(createNode(spec)));
  }

  return { render };
})();
