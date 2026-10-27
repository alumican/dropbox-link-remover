// A small imitation of dropbox.com/share/links: rows with a "…" button, a menu with
// "閲覧リンクを削除" / "編集リンクを削除", a confirmation dialog and a toast.
//
// Query parameters:
//   rows=basic|duplicates   data set (default: basic)
//   scenario=normal|submenu-ok|submenu-danger|file-dialog|no-confirm   menu / dialog behaviour (default: normal)
//   linger=<ms>             a fully deleted row stays listed (with a dead "…" button) this long before it disappears
//   loadDelay=<ms>          the list renders only after this delay, like a page that is still loading
//
// The page exposes window.mock for the test runner:
//   mock.links()   remaining links per row, e.g. [["閲覧リンク"], []]
//   mock.danger    actions that must never happen (clicking file deletion, generic "削除", ...)
(() => {
  const params = new URLSearchParams(location.search);
  const scenario = params.get('scenario') || 'normal';
  const linger = Number(params.get('linger') || 0);
  const loadDelay = Number(params.get('loadDelay') || 0);

  const DATA_SETS = {
    basic: [
      { name: 'Alpha.pdf 2023-04-21', links: ['閲覧リンク', '編集リンク'] },
      { name: 'Beta.docx 2023-04-21', links: ['閲覧リンク'] },
      { name: 'Gamma 2023-04-21', links: [], keep: true }, // listed, but has no link to delete
    ],
    duplicates: [
      { name: 'drop 2015-06-13 10:08', links: ['閲覧リンク'] },
      { name: 'drop 2015-06-13 10:08', links: ['閲覧リンク'] },
      { name: 'drop 2015-06-13 10:08', links: ['閲覧リンク', '編集リンク'] },
      { name: 'keep 2015-01-01 0:00', links: [], keep: true },
      { name: 'keep 2015-01-01 0:00', links: [], keep: true },
      { name: 'Beta.docx', links: ['閲覧リンク'] },
    ],
  };
  const data = structuredClone(DATA_SETS[params.get('rows') || 'basic']);
  const danger = [];
  const tbody = document.getElementById('rows');

  function render() {
    tbody.innerHTML = '';
    data.forEach((d, i) => {
      if (!d.links.length && !d.keep) return;
      const tr = document.createElement('tr');
      tr.dataset.index = i;
      tr.innerHTML = `<td>${d.name}</td><td><button data-testid="open-menu-button" aria-label="その他" aria-haspopup="true" style="width:20px;height:20px"></button></td>`;
      tr.querySelector('button').onclick = () => openRowMenu(i);
      tbody.appendChild(tr);
    });
  }

  const closeOverlays = () => document.querySelectorAll('.overlay').forEach((e) => e.remove());
  document.addEventListener('keydown', (e) => e.key === 'Escape' && closeOverlays());

  function showMenu(items) {
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
    document.body.appendChild(menu);
  }

  function openRowMenu(i) {
    const row = data[i];
    if (!row.links.length) return showMenu([['リンク設定', closeOverlays]]);
    const kind = row.links[0];
    const confirmLink = () => { closeOverlays(); showDialog(i, kind); };
    switch (scenario) {
      case 'submenu-ok': // "閲覧リンク" opens a submenu that holds the real delete item
        return showMenu([[kind, () => showMenu([[`${kind}を削除`, confirmLink], ['ファイルを削除', () => danger.push('file delete menu')]])]]);
      case 'submenu-danger': // the submenu only offers generic / file deletion
        return showMenu([[kind, () => showMenu([['削除', () => danger.push('generic delete')], ['ファイルを削除', () => danger.push('file delete menu')]])]]);
      case 'file-dialog': // the link item unexpectedly asks to delete a file
        return showMenu([[`${kind}を削除`, () => { closeOverlays(); showDialog(i, kind, { aboutFile: true }); }]]);
      case 'no-confirm': // the confirmation dialog has no delete-like button
        return showMenu([[`${kind}を削除`, () => { closeOverlays(); showDialog(i, kind, { okOnly: true }); }]]);
      default:
        return showMenu([...row.links.map((l) => [`${l}を削除`, () => { closeOverlays(); showDialog(i, l); }]), ['リンク設定', closeOverlays]]);
    }
  }

  function showDialog(i, kind, { aboutFile = false, okOnly = false } = {}) {
    const dialog = document.createElement('div');
    dialog.className = 'overlay';
    dialog.setAttribute('role', 'dialog');
    dialog.innerHTML = aboutFile
      ? '<p>このファイルを削除しますか?</p><button>キャンセル</button><button>削除</button>'
      : `<p>${kind}を削除しますか?</p><button>キャンセル</button><button>${okOnly ? 'OK' : 'リンクを削除'}</button>`;
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
        showToast(`「${data[i].name}」へのリンクを削除しました`);
      }, 200);
    };
    document.body.appendChild(dialog);
  }

  function showToast(text) {
    setTimeout(() => {
      const status = document.getElementById('status');
      status.textContent = text;
      setTimeout(() => (status.textContent = ''), 300);
    }, 100);
  }

  window.mock = { links: () => data.map((d) => d.links), danger };
  if (loadDelay) setTimeout(render, loadDelay);
  else render();
})();
