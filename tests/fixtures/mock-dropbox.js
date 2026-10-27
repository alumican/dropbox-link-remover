// A small imitation of dropbox.com/share/links: rows with a "…" button, a menu with
// "閲覧リンクを削除" / "編集リンクを削除", a confirmation dialog and a toast.
//
// Query parameters:
//   rows=basic|duplicates|demo   data set (default: basic)
//   scenario=normal|submenu-ok|submenu-danger|file-dialog|no-confirm   menu / dialog behaviour (default: normal)
//   ui=ja|en                Dropbox UI language of the mock (default: ja)
//   linger=<ms>             a fully deleted row stays listed (with a dead "…" button) this long before it disappears
//   loadDelay=<ms>          the list renders only after this delay, like a page that is still loading
//   demo=1 | demo=hero      styled page for screenshots (hero: transparent, list kept to the left)
//
// The page exposes window.mock for the test runner:
//   mock.links()   remaining links per row, e.g. [["view"], []]
//   mock.danger    actions that must never happen (clicking file deletion, generic "削除", ...)
(() => {
  const params = new URLSearchParams(location.search);
  const scenario = params.get('scenario') || 'normal';
  const linger = Number(params.get('linger') || 0);
  const loadDelay = Number(params.get('loadDelay') || 0);
  const demo = params.has('demo');

  const TEXT = {
    ja: {
      link: { view: '閲覧リンク', edit: '編集リンク' },
      deleteItem: (kind) => `${kind}を削除`,
      settings: 'リンク設定',
      genericDelete: '削除',
      fileDelete: 'ファイルを削除',
      confirmLink: (kind) => `${kind}を削除しますか?`,
      confirmFile: 'このファイルを削除しますか?',
      cancel: 'キャンセル',
      deleteLink: 'リンクを削除',
      deleteFile: '削除',
      toast: (name) => `「${name}」へのリンクを削除しました`,
      more: 'その他',
      sort: '並べ替えメニュー',
      header: ['名前', ''],
      sidebar: ['すべてのファイル', '写真', '共有済み'],
      menubar: ['ストレージを追加', 'YO'],
    },
    en: {
      link: { view: 'view link', edit: 'edit link' },
      deleteItem: (kind) => `Delete ${kind}`,
      settings: 'Link settings',
      genericDelete: 'Delete',
      fileDelete: 'Delete file',
      confirmLink: (kind) => `Delete this ${kind}?`,
      confirmFile: 'Delete this file?',
      cancel: 'Cancel',
      deleteLink: 'Delete link',
      deleteFile: 'Delete',
      toast: (name) => `Deleted link to “${name}”`,
      more: 'More',
      sort: 'Sort menu',
      header: ['Name', 'Created'],
      sidebar: ['All files', 'Photos', 'Shared'],
      menubar: ['Upgrade', 'YO'],
    },
  };
  const T = TEXT[params.get('ui') || 'ja'];

  const DATA_SETS = {
    basic: [
      { name: 'Alpha.pdf 2023-04-21', links: ['view', 'edit'] },
      { name: 'Beta.docx 2023-04-21', links: ['view'] },
      { name: 'Gamma 2023-04-21', links: [], keep: true }, // listed, but has no link to delete
    ],
    duplicates: [
      { name: 'drop 2015-06-13 10:08', links: ['view'] },
      { name: 'drop 2015-06-13 10:08', links: ['view'] },
      { name: 'drop 2015-06-13 10:08', links: ['view', 'edit'] },
      { name: 'keep 2015-01-01 0:00', links: [], keep: true },
      { name: 'keep 2015-01-01 0:00', links: [], keep: true },
      { name: 'Beta.docx', links: ['view'] },
    ],
    demo: [
      ['Brand guidelines.pdf', '2024-11-02'], ['Product photos', '2024-10-18'], ['Q3 report.xlsx', '2024-10-01'],
      ['Logo final.ai', '2024-09-12'], ['Meeting notes.docx', '2024-08-30'], ['Event 2024', '2024-08-03'],
      ['Pitch deck.key', '2024-07-21'], ['Interview.mp4', '2024-06-09'], ['Invoice 0815.pdf', '2024-05-15'],
      ['Wireframes.fig', '2024-04-27'], ['Recipes.txt', '2024-03-11'], ['Travel 2023', '2024-02-02'],
    ].map(([name, date], i) => ({ name, date, links: i % 4 === 1 ? ['view', 'edit'] : ['view'] })),
  };
  const data = structuredClone(DATA_SETS[params.get('rows') || 'basic']);
  const danger = [];

  // Page chrome: always-visible top bar and sidebar rows, like Dropbox's
  document.body.insertAdjacentHTML('afterbegin', `
    <div role="menubar">${T.menubar.map((t) => `<div role="menuitem">${t}</div>`).join('')}</div>
    <div class="sidebar">${T.sidebar.map((t) => `<div role="row">${t}</div>`).join('')}</div>
    <main><table>
      <thead><tr><th>${T.header[0]} <button aria-haspopup="true" aria-label="${T.sort}">▾</button></th><th>${T.header[1]}</th><th></th></tr></thead>
      <tbody id="rows"></tbody>
    </table></main>
    <div id="status" role="status"></div>`);
  const tbody = document.getElementById('rows');

  function render() {
    tbody.innerHTML = '';
    data.forEach((d, i) => {
      if (!d.links.length && !d.keep) return;
      const tr = document.createElement('tr');
      tr.dataset.index = i;
      tr.innerHTML = `<td>${d.name}</td><td>${d.date || ''}</td><td><button data-testid="open-menu-button" aria-label="${T.more}" aria-haspopup="true" style="width:20px;height:20px"></button></td>`;
      tr.querySelector('button').onclick = () => openRowMenu(i);
      tbody.appendChild(tr);
    });
  }

  const closeOverlays = () => document.querySelectorAll('.overlay').forEach((e) => e.remove());
  document.addEventListener('keydown', (e) => e.key === 'Escape' && closeOverlays());

  function showMenu(items, anchor) {
    closeOverlays();
    const menu = document.createElement('div');
    menu.className = 'overlay';
    menu.setAttribute('role', 'menu');
    for (const [label, onClick] of items) {
      const item = document.createElement('div');
      item.setAttribute('role', 'menuitem');
      item.textContent = label;
      item.onclick = onClick;
      menu.appendChild(item);
    }
    if (demo && anchor) {
      const r = anchor.getBoundingClientRect();
      Object.assign(menu.style, { top: `${r.bottom + 4}px`, left: `${r.right - 200}px` });
    }
    document.body.appendChild(menu);
  }

  function openRowMenu(i) {
    const row = data[i];
    const anchor = tbody.querySelector(`tr[data-index="${i}"] button`);
    if (!row.links.length) return showMenu([[T.settings, closeOverlays]], anchor);
    const kind = row.links[0];
    const label = T.deleteItem(T.link[kind]);
    const confirmLink = () => { closeOverlays(); showDialog(i, kind); };
    switch (scenario) {
      case 'submenu-ok': // "閲覧リンク" opens a submenu that holds the real delete item
        return showMenu([[T.link[kind], () => showMenu([[label, confirmLink], [T.fileDelete, () => danger.push('file delete menu')]], anchor)]], anchor);
      case 'submenu-danger': // the submenu only offers generic / file deletion
        return showMenu([[T.link[kind], () => showMenu([[T.genericDelete, () => danger.push('generic delete')], [T.fileDelete, () => danger.push('file delete menu')]], anchor)]], anchor);
      case 'file-dialog': // the link item unexpectedly asks to delete a file
        return showMenu([[label, () => { closeOverlays(); showDialog(i, kind, { aboutFile: true }); }]], anchor);
      case 'no-confirm': // the confirmation dialog has no delete-like button
        return showMenu([[label, () => { closeOverlays(); showDialog(i, kind, { okOnly: true }); }]], anchor);
      default:
        return showMenu([...row.links.map((k) => [T.deleteItem(T.link[k]), () => { closeOverlays(); showDialog(i, k); }]), [T.settings, closeOverlays]], anchor);
    }
  }

  function showDialog(i, kind, { aboutFile = false, okOnly = false } = {}) {
    const dialog = document.createElement('div');
    dialog.className = 'overlay';
    dialog.setAttribute('role', 'dialog');
    dialog.innerHTML = aboutFile
      ? `<p>${T.confirmFile}</p><button>${T.cancel}</button><button>${T.deleteFile}</button>`
      : `<p>${T.confirmLink(T.link[kind])}</p><button>${T.cancel}</button><button>${okOnly ? 'OK' : T.deleteLink}</button>`;
    const [cancel, confirm] = dialog.querySelectorAll('button');
    cancel.onclick = closeOverlays;
    confirm.onclick = () => {
      if (aboutFile) return danger.push('file deletion confirmed');
      if (okOnly) return closeOverlays();
      setTimeout(() => {
        closeOverlays();
        data[i].links = data[i].links.filter((l) => l !== kind);
        const tr = tbody.querySelector(`tr[data-index="${i}"]`);
        if (!data[i].links.length && linger && tr) {
          tr.querySelector('button').onclick = () => {}; // a row on its way out opens nothing
          setTimeout(render, linger);
        } else {
          render();
        }
        showToast(T.toast(data[i].name));
      }, 200);
    };
    document.body.appendChild(dialog);
  }

  function showToast(text) {
    setTimeout(() => {
      const status = document.getElementById('status');
      status.textContent = text;
      setTimeout(() => (status.textContent = ''), demo ? 1500 : 300);
    }, 100);
  }

  if (demo) {
    document.head.insertAdjacentHTML('beforeend', `<link rel="stylesheet" href="/tests/fixtures/mock-dropbox-demo.css">`);
    document.body.classList.add('demo');
    if (params.get('demo') === 'hero') document.body.classList.add('hero');
  }
  window.mock = { links: () => data.map((d) => d.links), danger };
  if (loadDelay) setTimeout(render, loadDelay);
  else render();
})();
