(() => {
  const root = document.documentElement;
  document.fonts.forEach(font => font.load());
  const icon = paths => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
  const icons = {
    theme: icon('<path d="M20 15.5A8 8 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z"/>'),
    close: icon('<path d="m6 6 12 12M6 18 18 6"/>'),
    copy: icon('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>'),
    check: icon('<path d="m5 12 4 4L19 6"/>'),
    chevron: icon('<path d="m7 10 5 5 5-5"/>')
  };
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  function animate(element, frames, duration = 180, iterations = 1) {
    element.getAnimations().forEach(animation => animation.cancel());
    if (!reduced()) element.animate(frames, { duration, iterations, easing: 'cubic-bezier(.23,1,.32,1)' });
  }
  const snapshots = new WeakMap();
  function fade(element) {
    if (element.matches('#origin-rows,#catalogue,#ledger-body,#call-rows,#result-body')) {
      const previous = snapshots.get(element);
      previous?.floating?.remove();
      const snapshot = { content: element.cloneNode(true) };
      snapshots.set(element, snapshot);
      if (previous && !reduced()) {
        const old = previous.content;
        const floating = document.createElement('div');
        const parent = element.parentElement;
        parent.style.position = 'relative';
        const bounds = element.getBoundingClientRect();
        const origin = parent.getBoundingClientRect();
        floating.setAttribute('aria-hidden', 'true');
        floating.inert = true;
        floating.classList.add('transition-clone');
        Object.assign(floating.style, {
          position: 'absolute', left: `${bounds.left-origin.left+parent.scrollLeft}px`,
          top: `${bounds.top-origin.top+parent.scrollTop}px`, width: `${bounds.width}px`,
          pointerEvents: 'none', margin: '0', zIndex: '3'
        });
        const shadow = floating.attachShadow({mode:'closed'});
        document.querySelectorAll('link[rel=stylesheet]').forEach(sheet => {
          const link = sheet.cloneNode();
          link.href = sheet.href;
          shadow.append(link);
        });
        old.style.width = '100%';
        if (element.tagName === 'TBODY') old.style.display = 'table';
        shadow.append(old);
        parent.append(floating);
        snapshot.floating = floating;
        const animation = floating.animate([{opacity:1},{opacity:0}],{duration:180,easing:'cubic-bezier(.23,1,.32,1)'});
        animation.finished.then(()=>floating.remove(),()=>floating.remove());
      }
    }
    animate(element, [{opacity: .25, transform: 'translateY(4px)'}, {opacity: 1, transform: 'translateY(0)'}]);
  }
  window.ui = { icons, fade, animate, reduced };
  try { const saved = localStorage.getItem('bill-bench-theme'); if (saved === 'light' || saved === 'dark') root.dataset.theme = saved; } catch {}
  const theme = document.createElement('button');
  theme.id = 'theme';
  theme.className = 'icon-button theme-toggle ghost';
  theme.innerHTML = icons.theme;
  theme.setAttribute('aria-label', 'Switch colour theme');
  theme.setAttribute('aria-pressed', String(root.dataset.theme === 'dark'));
  document.querySelector('header').append(theme);
  theme.addEventListener('click', () => {
    root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
    theme.setAttribute('aria-pressed', String(root.dataset.theme === 'dark'));
    try { localStorage.setItem('bill-bench-theme', root.dataset.theme); } catch {}
    fade(document.querySelector('main'));
  });
  document.querySelectorAll('select').forEach((select, index) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'combo';
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'combo-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    const label = document.querySelector(`label[for="${select.id}"]`)?.textContent.trim() || select.getAttribute('aria-label') || 'Choose';
    trigger.setAttribute('aria-label', label);
    const menu = document.createElement('div');
    menu.id = `options-${index}`;
    menu.className = 'combo-menu';
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', label);
    menu.hidden = true;
    trigger.setAttribute('aria-controls', menu.id);
    let options = [];
    const rebuild = () => {
    menu.replaceChildren();
    options = [...select.options].map(option => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = option.textContent;
      button.setAttribute('role', 'option');
      button.addEventListener('click', () => {
        select.value = option.value;
        select.dispatchEvent(new Event('change', {bubbles: true}));
        close();
        trigger.focus();
      });
      menu.append(button);
      return button;
    });
    };
    rebuild();
    const update = () => {
      trigger.innerHTML = `<span>${select.selectedOptions[0]?.textContent || 'Choose'}</span>${icons.chevron}`;
      options.forEach((option, position) => option.setAttribute('aria-selected', String(position === select.selectedIndex)));
    };
    const close = () => { menu.hidden = true; trigger.setAttribute('aria-expanded', 'false'); };
    const open = () => { menu.hidden = false; trigger.setAttribute('aria-expanded', 'true'); options[select.selectedIndex]?.focus(); };
    select.before(wrapper);
    wrapper.append(select, trigger, menu);
    select.hidden = true;
    trigger.addEventListener('click', () => menu.hidden ? open() : close());
    trigger.addEventListener('keydown', event => {
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); open(); }
    });
    menu.addEventListener('keydown', event => {
      let position = options.indexOf(document.activeElement);
      if (event.key === 'Escape') { close(); trigger.focus(); }
      if (event.key === 'Tab') close();
      if (event.key === 'ArrowDown') position = (position + 1) % options.length;
      else if (event.key === 'ArrowUp') position = (position + options.length - 1) % options.length;
      else if (event.key === 'Home') position = 0;
      else if (event.key === 'End') position = options.length - 1;
      else if (event.key.length === 1) position = options.findIndex(option => option.textContent.toLowerCase().startsWith(event.key.toLowerCase()));
      else return;
      event.preventDefault();
      options[position]?.focus();
    });
    document.addEventListener('pointerdown', event => { if (!wrapper.contains(event.target)) close(); });
    select.addEventListener('change', update);
    select.addEventListener('ui-sync', update);
    new MutationObserver(() => { rebuild(); update(); }).observe(select, {attributes: true, subtree: true, childList: true});
    update();
  });
  document.querySelectorAll('.segmented').forEach(group => {
    const indicator = document.createElement('span');
    indicator.className = 'segment-indicator';
    indicator.setAttribute('aria-hidden', 'true');
    group.prepend(indicator);
    const update = () => {
      const selected = group.querySelector('button[aria-current],button[aria-pressed=true]');
      if (!selected) return;
      group.style.setProperty('--segment-width', `${selected.offsetWidth}px`);
      indicator.style.transform = `translateX(${selected.offsetLeft - 4}px)`;
    };
    new MutationObserver(update).observe(group, {subtree: true, attributes: true, attributeFilter: ['aria-current', 'aria-pressed']});
    new ResizeObserver(update).observe(group);
    update();
  });
  document.querySelectorAll('.tab-overflow').forEach(wrapper => {
    const scroll = wrapper.querySelector('.tab-scroll');
    const more = wrapper.querySelector('[data-scroll-target]');
    const update = () => {
      const remaining = scroll.scrollWidth-scroll.clientWidth-scroll.scrollLeft;
      const overflowing = remaining > 2;
      wrapper.classList.toggle('is-overflow',overflowing);
      more.hidden = !overflowing;
    };
    more.addEventListener('click', () => scroll.scrollBy({left:160,behavior:reduced()?'instant':'smooth'}));
    scroll.addEventListener('scroll',update,{passive:true});
    new ResizeObserver(update).observe(wrapper);
    document.fonts.ready.then(update);
    update();
  });
  document.querySelectorAll('table').forEach(table => {
    table.querySelectorAll('th').forEach((head, column) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = head.textContent;
      button.setAttribute('aria-label', `Sort by ${head.textContent}`);
      head.replaceChildren(button);
      let ascending = false;
      button.addEventListener('click', () => {
        ascending = !ascending;
        table.querySelectorAll('th').forEach(cell => cell.removeAttribute('aria-sort'));
        head.setAttribute('aria-sort', ascending ? 'ascending' : 'descending');
        const body = table.tBodies[0];
        body.querySelector('.row-detail')?.remove();
        const rows = [...body.rows];
        const value = row => row.cells[column]?.textContent.trim() || '';
        rows.sort((a,b) => value(a).localeCompare(value(b), undefined, {numeric: true}) * (ascending ? 1 : -1));
        body.replaceChildren(...rows);
        fade(body);
      });
    });
    if (table.hasAttribute('data-expand')) {
      table.addEventListener('click', event => {
        if (event.target.closest('a,thead,.row-detail')) return;
        const row = event.target.closest('tr');
        if (!row) return;
        const already = row.classList.contains('selected-row');
        table.querySelector('.row-detail')?.remove();
        table.querySelectorAll('.selected-row').forEach(item => item.classList.remove('selected-row'));
        if (already) return;
        row.classList.add('selected-row');
        const detail = document.createElement('tr');
        detail.className = 'row-detail';
        const cell = detail.insertCell();
        cell.colSpan = row.cells.length;
        cell.textContent = row.dataset.detail || [...row.cells].map((cell,index) => `${table.tHead.rows[0].cells[index].textContent} · ${cell.textContent}`).join('   ');
        row.after(detail);
        fade(detail);
      });
      table.addEventListener('keydown', event => { if (event.key === 'Enter' && event.target.matches('tbody tr')) event.target.click(); });
    }
  });
  document.querySelectorAll('dialog').forEach(dialog => {
    const nativeClose = dialog.close.bind(dialog);
    const nativeOpen = dialog.showModal.bind(dialog);
    let closeTimer;
    dialog.close = value => {
      clearTimeout(closeTimer);
      if (reduced()) { nativeClose(value); return; }
      dialog.style.transform = dialog.classList.contains('sheet') ? 'translateX(32px)' : 'translateY(8px)';
      dialog.style.opacity = '0';
      closeTimer = setTimeout(() => {
        nativeClose(value);
        dialog.style.transform = '';
        dialog.style.opacity = '';
      },220);
    };
    dialog.showModal = () => {
      clearTimeout(closeTimer);
      dialog.style.transform = '';
      dialog.style.opacity = '';
      nativeOpen();
    };
    dialog.addEventListener('cancel', event => { event.preventDefault(); dialog.close(); });
    dialog.querySelectorAll('form[method=dialog]').forEach(form => form.addEventListener('submit', event => {
      event.preventDefault();
      dialog.close(event.submitter?.value);
    }));
    dialog.querySelectorAll('.close,[data-close]').forEach(button => button.innerHTML = icons.close);
    dialog.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => dialog.close()));
    dialog.addEventListener('click', event => { if (event.target === dialog && event.clientX < dialog.getBoundingClientRect().left) dialog.close(); });
  });
})();
