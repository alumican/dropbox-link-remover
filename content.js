// Dropbox Link Remover - content script
// On dropbox.com/share/links, repeatedly opens each row's "…" menu, picks the view link /
// edit link item, and presses the delete button in the confirmation dialog until nothing is left.
// Dropbox class names are unstable, so elements are located by role, aria-label and visible text.
(() => {
  if (window.__dlrLoaded) return;
  window.__dlrLoaded = true;

  // ---- Constants ----
  const LINKS_URL = 'https://www.dropbox.com/share/links';
  const LINKS_PATH_RE = /^\/share\/links/;
  const TOGGLE_MESSAGE = 'dlr-toggle'; // must match background.js
  const STORAGE_KEY = 'dlrSettings';
  const HOST_ID = 'dlr-host';
  const FONTS_LINK_ID = 'dlr-fonts';
  // Loaded into the page (Dropbox's CSP allows https:// styles and fonts); @font-face also applies inside the shadow root
  const GOOGLE_FONTS_URL =
    'https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&family=Noto+Sans+JP:wght@400;500;700&display=swap';
  const MORE_BUTTON_TESTID = 'open-menu-button'; // data-testid of Dropbox's "…" button
  // Language-independent markers in Dropbox's markup (checked in Japanese, English, French and Chinese)
  const DELETE_LINK_ITEM_CLASS_RE = /^delete-(?:(view|edit)-)?link$/; // the "Delete view link" item has class "delete-link"
  const CONFIRM_DIALOG_SELECTOR = '.db-modal';
  const CONFIRM_BUTTON_SELECTOR = '.button-primary.dbmodal-button';
  const CANCEL_BUTTON_SELECTOR = '.button-tertiary.dbmodal-button, .db-modal-x';

  // Timing (ms)
  const DEFAULT_DELAY_MS = 300; // wait between deletions
  const POLL_INTERVAL_MS = 100; // polling interval of waitFor()
  const DEFAULT_WAIT_TIMEOUT_MS = 5000;
  const ESCAPE_WAIT_MS = 250; // after pressing Escape to close a menu / dialog
  const HOVER_WAIT_MS = 1000; // for the "…" button to appear after hovering a row
  const MENU_OPEN_TIMEOUT_MS = 1500; // per click attempt on the "…" button
  const DIALOG_OPEN_TIMEOUT_MS = 2500; // per click attempt on the menu item
  const SUBMENU_DIALOG_TIMEOUT_MS = 3000;
  const CONFIRM_SETTLE_MS = 300; // before pressing the confirm button
  const DIALOG_CLOSE_TIMEOUT_MS = 10000; // for the deletion to complete
  const ROW_REMOVAL_TIMEOUT_MS = 3000; // after a deletion, for Dropbox to drop the row from the list
  const LIST_READY_TIMEOUT_MS = 15000; // at start, for the link list to appear while the page is still loading
  const LOAD_MORE_TIMEOUT_MS = 5000; // after pressing "Show more"
  const SCROLL_LOAD_TIMEOUT_MS = 3000; // after scrolling to the bottom
  const DIAGNOSE_HOVER_WAIT_MS = 600;
  const DIAGNOSE_DIALOG_CLOSE_MS = 1500; // per attempt to close the inspected confirmation dialog
  const VISIBILITY_CHECK_MS = 1000; // panel show / hide check (follows SPA navigation)

  // Limits
  const MAX_ESCAPE_PRESSES = 3;
  const MAX_ATTEMPTS_PER_ROW = 6; // a row is skipped after this many visits
  const FAILURES_BEFORE_ROW_SKIP = 3;
  const MAX_CONSECUTIVE_FAILURES = 5; // the run stops after this many failures in a row
  const SCROLLABLE_MIN_OVERFLOW_PX = 50;
  const ROW_KEY_LENGTH = 200; // characters of row text used to identify a row
  const LOG_PREVIEW_LENGTH = 60; // characters of row / button text shown in the log
  const DIAGNOSE_MAX_BUTTONS = 10;
  const SKIPPED_LIST_MAX = 10; // skipped rows listed in the end-of-run summary
  const MAX_LOG_LINES = 500;
  const COPY_FEEDBACK_MS = 1500; // how long the copy icon shows a check mark after copying

  // Trusted (real) input events that stop a run. Programmatic scrolling fires no wheel / touch / key events,
  // and the script's own synthetic events have isTrusted = false. Input inside the panel is ignored.
  const USER_ACTIVITY_EVENTS = ['wheel', 'touchmove', 'pointerdown', 'keydown'];

  // ---- Text patterns (match the Japanese and English UI) ----
  const VIEW_RE = /閲覧(用)?リンク|view(-only|er)?\s*link|link\s*for\s*view/i;
  const EDIT_RE = /編集(用)?リンク|edit(or)?\s*link|link\s*for\s*edit/i;
  const GENERIC_DELETE_LINK_RE = /リンクを削除|リンクの削除|delete\s*link|remove\s*link/i;
  const DELETE_RE = /削除|delete|remove|無効/i;
  // A confirmation dialog must mention links before its delete button is pressed. "link" in Dropbox's languages:
  // ja, en/de/nl/it/pt/pl/da, fr, es, ru, uk, sv, nb, id, ms, th, ko, zh-Hans, zh-Hant
  const LINK_RE = /リンク|link|lien|enlace|vínculo|ссылк|посилан|länk|lenke|kobling|tautan|pautan|ลิงก์|링크|链接|連結/i;
  const NON_DELETE_RE = /コピー|copy|設定|setting|作成|create|表示|開く|open|変更|change/i;
  const CANCEL_RE = /キャンセル|cancel|閉じる|close|戻る|back|いいえ|no\b/i;
  const MORE_LABEL_RE = /その他|もっと|アクション|オプション|メニュー|more|action|option|overflow|menu|…|\.\.\.|⋯/i;
  const MORE_TEXT_RE = /^(…|\.\.\.|⋯|・・・|•••)$/;
  const LOAD_MORE_RE = /さらに表示|もっと見る|続きを表示|load\s*more|show\s*more|see\s*more/i;

  // Buttons are excluded: the row's "…" button itself has data-testid="open-menu-button"
  const MENU_SELECTOR =
    '[role="menu"], [role="listbox"], [class*="dig-Menu" i]:not(button), [data-testid*="menu" i]:not(button):not([role="button"])';
  const MENU_ITEM_SELECTOR = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"]';
  const DIALOG_SELECTOR = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [class*="dig-Modal" i]';
  const NOTICE_SELECTOR = '[role="alert"], [role="status"], [aria-live="polite"], [aria-live="assertive"], [class*="snackbar" i], [class*="toast" i]';

  // ---- Settings ----
  const settings = { view: true, edit: true, delay: DEFAULT_DELAY_MS };

  // ---- State ----
  let running = false;
  let stopRequested = false;
  let deletedTotal = 0;
  let stoppedByUser = false;

  // ---- Extension context ----
  // When the extension is reloaded or updated, this script keeps running in already-open tabs,
  // but every chrome.* call throws "Extension context invalidated". Such an orphaned script tears itself down.
  const contextValid = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };

  // ---- Panel strings ----
  // The panel follows the Dropbox UI language (<html lang>), not the browser's; anything else falls back to English.
  // One entry per Dropbox UI language. uiCount places the counter at $1; it is a string, or forms keyed by
  // Intl.PluralRules category (plus an optional `zero`), falling back to `other`.
  // (_locales/ only holds the extension's name and description, which Chrome shows in the browser's language.)
  const UI_MESSAGES = {
    en: {
      uiRunning: 'Running',
      uiCollapse: 'Collapse',
      uiExpand: 'Expand',
      uiTargets: 'Targets',
      uiViewLinks: 'View links',
      uiEditLinks: 'Edit links',
      uiDeleteAll: 'Run all',
      uiStart: 'Start',
      uiStop: 'Stop',
      uiCount: { zero: '$1 link deleted', one: '$1 link deleted', other: '$1 links deleted' },
      uiTest: 'Test',
      uiDiagnose: 'Diagnose',
      uiDeleteOne: 'Run 1',
      uiCopyLog: 'Copy log',
      uiNote: 'Deleted links cannot be restored. Do not use this tab while it is running.',
      kindView: 'view links',
      kindEdit: 'edit links',
      kindSeparator: ' and ',
      confirmDeleteAll: 'Delete all $1 in the list? This cannot be undone.',
      uiStoppedByUser: 'Stopped because user activity was detected.',
    },
    ja: {
      uiRunning: '実行中',
      uiCollapse: '折りたたむ',
      uiExpand: '展開する',
      uiTargets: '削除対象',
      uiViewLinks: '閲覧リンク',
      uiEditLinks: '編集リンク',
      uiDeleteAll: 'すべて実行',
      uiStart: '開始',
      uiStop: '停止',
      uiCount: '$1件のリンクを削除',
      uiTest: 'テスト',
      uiDiagnose: '診断',
      uiDeleteOne: '1件実行',
      uiCopyLog: 'ログをコピー',
      uiNote: '削除したリンクは元に戻せません。実行中はこのタブを操作しないでください。',
      kindView: '閲覧リンク',
      kindEdit: '編集リンク',
      kindSeparator: '・',
      confirmDeleteAll: '一覧にあるすべての$1を削除します。元に戻せません。よろしいですか?',
      uiStoppedByUser: 'ユーザーの操作を検出したため停止しました',
    },
    da: {
      uiRunning: 'Kører',
      uiCollapse: 'Skjul',
      uiExpand: 'Udvid',
      uiTargets: 'Mål',
      uiViewLinks: 'Visningslinks',
      uiEditLinks: 'Redigeringslinks',
      uiDeleteAll: 'Kør alle',
      uiStart: 'Start',
      uiStop: 'Stop',
      uiCount: { one: '$1 link slettet', other: '$1 links slettet' },
      uiTest: 'Test',
      uiDiagnose: 'Diagnosticer',
      uiDeleteOne: 'Kør 1',
      uiCopyLog: 'Kopiér log',
      uiNote: 'Slettede links kan ikke gendannes. Brug ikke denne fane, mens den kører.',
      kindView: 'visningslinks',
      kindEdit: 'redigeringslinks',
      kindSeparator: ' og ',
      confirmDeleteAll: 'Vil du slette alle $1 på listen? Det kan ikke fortrydes.',
      uiStoppedByUser: 'Stoppet, fordi der blev registreret brugeraktivitet.',
    },
    de: {
      uiRunning: 'Läuft',
      uiCollapse: 'Einklappen',
      uiExpand: 'Ausklappen',
      uiTargets: 'Ziele',
      uiViewLinks: 'Ansichtslinks',
      uiEditLinks: 'Bearbeitungslinks',
      uiDeleteAll: 'Alle ausführen',
      uiStart: 'Starten',
      uiStop: 'Stoppen',
      uiCount: { one: '$1 Link gelöscht', other: '$1 Links gelöscht' },
      uiTest: 'Test',
      uiDiagnose: 'Diagnose',
      uiDeleteOne: '1 ausführen',
      uiCopyLog: 'Protokoll kopieren',
      uiNote: 'Gelöschte Links können nicht wiederhergestellt werden. Verwenden Sie diesen Tab nicht, während der Vorgang läuft.',
      kindView: 'Ansichtslinks',
      kindEdit: 'Bearbeitungslinks',
      kindSeparator: ' und ',
      confirmDeleteAll: 'Alle $1 in der Liste löschen? Dies kann nicht rückgängig gemacht werden.',
      uiStoppedByUser: 'Angehalten, da eine Benutzeraktivität erkannt wurde.',
    },
    es: {
      uiRunning: 'En ejecución',
      uiCollapse: 'Contraer',
      uiExpand: 'Expandir',
      uiTargets: 'Objetivos',
      uiViewLinks: 'Enlaces de visualización',
      uiEditLinks: 'Enlaces de edición',
      uiDeleteAll: 'Ejecutar todo',
      uiStart: 'Iniciar',
      uiStop: 'Detener',
      uiCount: { one: '$1 enlace eliminado', other: '$1 enlaces eliminados' },
      uiTest: 'Prueba',
      uiDiagnose: 'Diagnosticar',
      uiDeleteOne: 'Ejecutar 1',
      uiCopyLog: 'Copiar registro',
      uiNote: 'Los enlaces eliminados no se pueden restaurar. No uses esta pestaña mientras se ejecuta.',
      kindView: 'enlaces de visualización',
      kindEdit: 'enlaces de edición',
      kindSeparator: ' y ',
      confirmDeleteAll: '¿Eliminar todos los $1 de la lista? Esta acción no se puede deshacer.',
      uiStoppedByUser: 'Se detuvo porque se detectó actividad del usuario.',
    },
    fr: {
      uiRunning: 'En cours',
      uiCollapse: 'Réduire',
      uiExpand: 'Développer',
      uiTargets: 'Cibles',
      uiViewLinks: 'Liens de consultation',
      uiEditLinks: 'Liens de modification',
      uiDeleteAll: 'Tout exécuter',
      uiStart: 'Démarrer',
      uiStop: 'Arrêter',
      uiCount: { one: '$1 lien supprimé', other: '$1 liens supprimés' },
      uiTest: 'Test',
      uiDiagnose: 'Diagnostic',
      uiDeleteOne: 'Exécuter 1',
      uiCopyLog: 'Copier le journal',
      uiNote: 'Les liens supprimés ne peuvent pas être restaurés. N’utilisez pas cet onglet pendant l’exécution.',
      kindView: 'liens de consultation',
      kindEdit: 'liens de modification',
      kindSeparator: ' et ',
      confirmDeleteAll: 'Supprimer tous les $1 de la liste ? Cette action est irréversible.',
      uiStoppedByUser: 'Arrêté, car une activité de l’utilisateur a été détectée.',
    },
    id: {
      uiRunning: 'Berjalan',
      uiCollapse: 'Ciutkan',
      uiExpand: 'Bentangkan',
      uiTargets: 'Target',
      uiViewLinks: 'Tautan lihat',
      uiEditLinks: 'Tautan edit',
      uiDeleteAll: 'Jalankan semua',
      uiStart: 'Mulai',
      uiStop: 'Hentikan',
      uiCount: '$1 tautan dihapus',
      uiTest: 'Uji',
      uiDiagnose: 'Diagnosis',
      uiDeleteOne: 'Jalankan 1',
      uiCopyLog: 'Salin log',
      uiNote: 'Tautan yang dihapus tidak dapat dipulihkan. Jangan gunakan tab ini saat sedang berjalan.',
      kindView: 'tautan lihat',
      kindEdit: 'tautan edit',
      kindSeparator: ' dan ',
      confirmDeleteAll: 'Hapus semua $1 dalam daftar? Tindakan ini tidak dapat dibatalkan.',
      uiStoppedByUser: 'Dihentikan karena aktivitas pengguna terdeteksi.',
    },
    it: {
      uiRunning: 'In esecuzione',
      uiCollapse: 'Comprimi',
      uiExpand: 'Espandi',
      uiTargets: 'Obiettivi',
      uiViewLinks: 'Link di visualizzazione',
      uiEditLinks: 'Link di modifica',
      uiDeleteAll: 'Esegui tutto',
      uiStart: 'Avvia',
      uiStop: 'Interrompi',
      uiCount: { one: '$1 link eliminato', other: '$1 link eliminati' },
      uiTest: 'Test',
      uiDiagnose: 'Diagnostica',
      uiDeleteOne: 'Esegui 1',
      uiCopyLog: 'Copia log',
      uiNote: 'I link eliminati non possono essere ripristinati. Non usare questa scheda durante l’esecuzione.',
      kindView: 'link di visualizzazione',
      kindEdit: 'link di modifica',
      kindSeparator: ' e ',
      confirmDeleteAll: 'Eliminare tutti i $1 nell’elenco? L’operazione non può essere annullata.',
      uiStoppedByUser: 'Interrotto perché è stata rilevata un’attività dell’utente.',
    },
    ko: {
      uiRunning: '실행 중',
      uiCollapse: '접기',
      uiExpand: '펼치기',
      uiTargets: '삭제 대상',
      uiViewLinks: '보기 링크',
      uiEditLinks: '편집 링크',
      uiDeleteAll: '모두 실행',
      uiStart: '시작',
      uiStop: '중지',
      uiCount: '$1개 링크 삭제됨',
      uiTest: '테스트',
      uiDiagnose: '진단',
      uiDeleteOne: '1개 실행',
      uiCopyLog: '로그 복사',
      uiNote: '삭제한 링크는 복원할 수 없습니다. 실행 중에는 이 탭을 조작하지 마세요.',
      kindView: '보기 링크',
      kindEdit: '편집 링크',
      kindSeparator: ' 및 ',
      confirmDeleteAll: '목록에 있는 모든 $1를 삭제할까요? 되돌릴 수 없습니다.',
      uiStoppedByUser: '사용자 활동이 감지되어 중지했습니다.',
    },
    ms: {
      uiRunning: 'Sedang berjalan',
      uiCollapse: 'Kuncupkan',
      uiExpand: 'Kembangkan',
      uiTargets: 'Sasaran',
      uiViewLinks: 'Pautan lihat',
      uiEditLinks: 'Pautan edit',
      uiDeleteAll: 'Jalankan semua',
      uiStart: 'Mula',
      uiStop: 'Henti',
      uiCount: '$1 pautan dipadam',
      uiTest: 'Ujian',
      uiDiagnose: 'Diagnosis',
      uiDeleteOne: 'Jalankan 1',
      uiCopyLog: 'Salin log',
      uiNote: 'Pautan yang dipadam tidak boleh dipulihkan. Jangan gunakan tab ini semasa ia berjalan.',
      kindView: 'pautan lihat',
      kindEdit: 'pautan edit',
      kindSeparator: ' dan ',
      confirmDeleteAll: 'Padam semua $1 dalam senarai? Tindakan ini tidak boleh dibuat asal.',
      uiStoppedByUser: 'Dihentikan kerana aktiviti pengguna dikesan.',
    },
    nb: {
      uiRunning: 'Kjører',
      uiCollapse: 'Skjul',
      uiExpand: 'Vis',
      uiTargets: 'Mål',
      uiViewLinks: 'Visningslenker',
      uiEditLinks: 'Redigeringslenker',
      uiDeleteAll: 'Kjør alle',
      uiStart: 'Start',
      uiStop: 'Stopp',
      uiCount: { one: '$1 lenke slettet', other: '$1 lenker slettet' },
      uiTest: 'Test',
      uiDiagnose: 'Diagnostiser',
      uiDeleteOne: 'Kjør 1',
      uiCopyLog: 'Kopier logg',
      uiNote: 'Slettede lenker kan ikke gjenopprettes. Ikke bruk denne fanen mens den kjører.',
      kindView: 'visningslenker',
      kindEdit: 'redigeringslenker',
      kindSeparator: ' og ',
      confirmDeleteAll: 'Vil du slette alle $1 i listen? Dette kan ikke angres.',
      uiStoppedByUser: 'Stoppet fordi brukeraktivitet ble oppdaget.',
    },
    nl: {
      uiRunning: 'Bezig',
      uiCollapse: 'Samenvouwen',
      uiExpand: 'Uitvouwen',
      uiTargets: 'Doelen',
      uiViewLinks: 'Weergavelinks',
      uiEditLinks: 'Bewerkingslinks',
      uiDeleteAll: 'Alles uitvoeren',
      uiStart: 'Starten',
      uiStop: 'Stoppen',
      uiCount: { one: '$1 link verwijderd', other: '$1 links verwijderd' },
      uiTest: 'Test',
      uiDiagnose: 'Diagnose',
      uiDeleteOne: '1 uitvoeren',
      uiCopyLog: 'Logboek kopiëren',
      uiNote: 'Verwijderde links kunnen niet worden hersteld. Gebruik dit tabblad niet terwijl het bezig is.',
      kindView: 'weergavelinks',
      kindEdit: 'bewerkingslinks',
      kindSeparator: ' en ',
      confirmDeleteAll: 'Alle $1 in de lijst verwijderen? Dit kan niet ongedaan worden gemaakt.',
      uiStoppedByUser: 'Gestopt omdat gebruikersactiviteit is gedetecteerd.',
    },
    pl: {
      uiRunning: 'Trwa',
      uiCollapse: 'Zwiń',
      uiExpand: 'Rozwiń',
      uiTargets: 'Cele',
      uiViewLinks: 'Linki do wyświetlania',
      uiEditLinks: 'Linki do edycji',
      uiDeleteAll: 'Uruchom wszystko',
      uiStart: 'Start',
      uiStop: 'Zatrzymaj',
      uiCount: { one: '$1 link usunięty', few: '$1 linki usunięte', many: '$1 linków usuniętych', other: '$1 linku usuniętego' },
      uiTest: 'Test',
      uiDiagnose: 'Diagnostyka',
      uiDeleteOne: 'Uruchom 1',
      uiCopyLog: 'Kopiuj dziennik',
      uiNote: 'Usuniętych linków nie można przywrócić. Nie używaj tej karty podczas działania.',
      kindView: 'linki do wyświetlania',
      kindEdit: 'linki do edycji',
      kindSeparator: ' i ',
      confirmDeleteAll: 'Usunąć wszystkie $1 z listy? Tej operacji nie można cofnąć.',
      uiStoppedByUser: 'Zatrzymano, ponieważ wykryto aktywność użytkownika.',
    },
    pt: {
      uiRunning: 'Em execução',
      uiCollapse: 'Recolher',
      uiExpand: 'Expandir',
      uiTargets: 'Alvos',
      uiViewLinks: 'Links de visualização',
      uiEditLinks: 'Links de edição',
      uiDeleteAll: 'Executar tudo',
      uiStart: 'Iniciar',
      uiStop: 'Parar',
      uiCount: { one: '$1 link excluído', other: '$1 links excluídos' },
      uiTest: 'Teste',
      uiDiagnose: 'Diagnosticar',
      uiDeleteOne: 'Executar 1',
      uiCopyLog: 'Copiar log',
      uiNote: 'Links excluídos não podem ser restaurados. Não use esta aba durante a execução.',
      kindView: 'links de visualização',
      kindEdit: 'links de edição',
      kindSeparator: ' e ',
      confirmDeleteAll: 'Excluir todos os $1 da lista? Esta ação não pode ser desfeita.',
      uiStoppedByUser: 'Interrompido porque foi detectada atividade do usuário.',
    },
    ru: {
      uiRunning: 'Выполняется',
      uiCollapse: 'Свернуть',
      uiExpand: 'Развернуть',
      uiTargets: 'Цели',
      uiViewLinks: 'Ссылки для просмотра',
      uiEditLinks: 'Ссылки для редактирования',
      uiDeleteAll: 'Выполнить все',
      uiStart: 'Начать',
      uiStop: 'Остановить',
      uiCount: { one: '$1 ссылка удалена', few: '$1 ссылки удалены', many: '$1 ссылок удалено', other: '$1 ссылки удалено' },
      uiTest: 'Тест',
      uiDiagnose: 'Диагностика',
      uiDeleteOne: 'Выполнить 1',
      uiCopyLog: 'Копировать журнал',
      uiNote: 'Удалённые ссылки невозможно восстановить. Не пользуйтесь этой вкладкой во время работы.',
      kindView: 'ссылки для просмотра',
      kindEdit: 'ссылки для редактирования',
      kindSeparator: ' и ',
      confirmDeleteAll: 'Удалить все $1 в списке? Это действие нельзя отменить.',
      uiStoppedByUser: 'Остановлено: обнаружены действия пользователя.',
    },
    sv: {
      uiRunning: 'Körs',
      uiCollapse: 'Fäll ihop',
      uiExpand: 'Expandera',
      uiTargets: 'Mål',
      uiViewLinks: 'Visningslänkar',
      uiEditLinks: 'Redigeringslänkar',
      uiDeleteAll: 'Kör alla',
      uiStart: 'Starta',
      uiStop: 'Stoppa',
      uiCount: { one: '$1 länk borttagen', other: '$1 länkar borttagna' },
      uiTest: 'Test',
      uiDiagnose: 'Diagnostisera',
      uiDeleteOne: 'Kör 1',
      uiCopyLog: 'Kopiera logg',
      uiNote: 'Borttagna länkar kan inte återställas. Använd inte den här fliken medan den körs.',
      kindView: 'visningslänkar',
      kindEdit: 'redigeringslänkar',
      kindSeparator: ' och ',
      confirmDeleteAll: 'Ta bort alla $1 i listan? Det går inte att ångra.',
      uiStoppedByUser: 'Stoppad eftersom användaraktivitet upptäcktes.',
    },
    th: {
      uiRunning: 'กำลังทำงาน',
      uiCollapse: 'ยุบ',
      uiExpand: 'ขยาย',
      uiTargets: 'เป้าหมาย',
      uiViewLinks: 'ลิงก์สำหรับดู',
      uiEditLinks: 'ลิงก์สำหรับแก้ไข',
      uiDeleteAll: 'เรียกใช้ทั้งหมด',
      uiStart: 'เริ่ม',
      uiStop: 'หยุด',
      uiCount: '$1 ลิงก์ถูกลบแล้ว',
      uiTest: 'ทดสอบ',
      uiDiagnose: 'วินิจฉัย',
      uiDeleteOne: 'เรียกใช้ 1 รายการ',
      uiCopyLog: 'คัดลอกบันทึก',
      uiNote: 'ลิงก์ที่ลบแล้วไม่สามารถกู้คืนได้ อย่าใช้งานแท็บนี้ขณะกำลังทำงาน',
      kindView: 'ลิงก์สำหรับดู',
      kindEdit: 'ลิงก์สำหรับแก้ไข',
      kindSeparator: ' และ ',
      confirmDeleteAll: 'ลบ$1ทั้งหมดในรายการหรือไม่ การดำเนินการนี้ไม่สามารถย้อนกลับได้',
      uiStoppedByUser: 'หยุดแล้วเนื่องจากตรวจพบการใช้งานของผู้ใช้',
    },
    uk: {
      uiRunning: 'Виконується',
      uiCollapse: 'Згорнути',
      uiExpand: 'Розгорнути',
      uiTargets: 'Цілі',
      uiViewLinks: 'Посилання для перегляду',
      uiEditLinks: 'Посилання для редагування',
      uiDeleteAll: 'Виконати все',
      uiStart: 'Почати',
      uiStop: 'Зупинити',
      uiCount: { one: '$1 посилання видалено', few: '$1 посилання видалено', many: '$1 посилань видалено', other: '$1 посилання видалено' },
      uiTest: 'Тест',
      uiDiagnose: 'Діагностика',
      uiDeleteOne: 'Виконати 1',
      uiCopyLog: 'Копіювати журнал',
      uiNote: 'Видалені посилання неможливо відновити. Не користуйтеся цією вкладкою під час роботи.',
      kindView: 'посилання для перегляду',
      kindEdit: 'посилання для редагування',
      kindSeparator: ' і ',
      confirmDeleteAll: 'Видалити всі $1 у списку? Цю дію неможливо скасувати.',
      uiStoppedByUser: 'Зупинено: виявлено дії користувача.',
    },
    'zh-Hans': {
      uiRunning: '运行中',
      uiCollapse: '收起',
      uiExpand: '展开',
      uiTargets: '删除对象',
      uiViewLinks: '查看链接',
      uiEditLinks: '编辑链接',
      uiDeleteAll: '全部执行',
      uiStart: '开始',
      uiStop: '停止',
      uiCount: '$1 个链接已删除',
      uiTest: '测试',
      uiDiagnose: '诊断',
      uiDeleteOne: '执行 1 个',
      uiCopyLog: '复制日志',
      uiNote: '已删除的链接无法恢复。运行期间请勿操作此标签页。',
      kindView: '查看链接',
      kindEdit: '编辑链接',
      kindSeparator: '和',
      confirmDeleteAll: '要删除列表中的所有$1吗？此操作无法撤销。',
      uiStoppedByUser: '检测到用户操作，已停止。',
    },
    'zh-Hant': {
      uiRunning: '執行中',
      uiCollapse: '收合',
      uiExpand: '展開',
      uiTargets: '刪除對象',
      uiViewLinks: '檢視連結',
      uiEditLinks: '編輯連結',
      uiDeleteAll: '全部執行',
      uiStart: '開始',
      uiStop: '停止',
      uiCount: '$1 個連結已刪除',
      uiTest: '測試',
      uiDiagnose: '診斷',
      uiDeleteOne: '執行 1 個',
      uiCopyLog: '複製記錄',
      uiNote: '已刪除的連結無法復原。執行期間請勿操作此分頁。',
      kindView: '檢視連結',
      kindEdit: '編輯連結',
      kindSeparator: '和',
      confirmDeleteAll: '要刪除清單中的所有$1嗎？此操作無法復原。',
      uiStoppedByUser: '偵測到使用者操作，已停止。',
    },
  };
  const UI_LANG = (() => {
    const [lang, ...subtags] = (document.documentElement.lang || '').toLowerCase().split(/[-_]/);
    if (lang === 'zh') return subtags.some((s) => ['hant', 'tw', 'hk', 'mo'].includes(s)) ? 'zh-Hant' : 'zh-Hans';
    if (lang === 'no' || lang === 'nn') return 'nb';
    return lang in UI_MESSAGES ? lang : 'en';
  })();

  // $1..$9 are replaced with the substitutions, like chrome.i18n.getMessage
  const format = (template, subs) => template.replace(/\$([1-9])/g, (_, d) => String(subs[d - 1] ?? ''));
  const t = (key, ...subs) => format(UI_MESSAGES[UI_LANG][key] ?? UI_MESSAGES.en[key] ?? key, subs);
  const pluralRules = new Intl.PluralRules(UI_LANG);
  // The counter text for n, with `num` (HTML) in place of $1
  const countText = (n, num) => {
    const forms = UI_MESSAGES[UI_LANG].uiCount;
    const template = typeof forms === 'string' ? forms : (n === 0 && forms.zero) || forms[pluralRules.select(n)] || forms.other;
    return format(template, [num]);
  };

  // ---- Log messages (always English, so logs read the same whatever the UI language) ----
  const LOG_MESSAGES = {
    logReady: 'Ready. Press “$1” first to check that items can be detected.', // $1: Diagnose button label
    logSelectTargets: 'Select at least one target.',
    logStopping: 'Stopping…',
    logCopied: 'Log copied.',
    logCopyFailed: 'Could not copy the log.',
    overlaySummary: 'menus $1 / dialogs $2',
    overlayMenuItems: 'menu items: $1',
    overlayDialog: 'dialog[$1] "$2" buttons: $3',
    none: 'none',
    logMenuNotOpened: 'Menu did not open: $1 ($2)',
    reasonMenuNotOpened: 'menu does not open',
    logNothingToDelete: 'No link to delete: $1 (menu: $2)',
    reasonNothingToDelete: 'no link to delete ($1)',
    logStillShown: '“$1” is still shown although the link was deleted last time (the link deletion may not have taken effect)',
    logSelectItem: 'Selected “$1”: $2',
    logRetryPointer: 'No confirmation dialog; clicking again with pointer events',
    logSelectSubmenu: 'Selected submenu “$1”',
    logSubmenuIgnored: 'Not clicked (not a link deletion): $1',
    logNoConfirmButton: 'Delete button in the confirmation dialog not found ($1)',
    reasonNoConfirmButton: 'no delete button in the confirmation dialog',
    logClickConfirm: 'Clicked “$1” in the confirmation dialog',
    logDialogNotClosed: 'Dialog did not close (the link deletion may not have completed) ($1)',
    reasonDialogNotClosed: 'dialog does not close',
    logClickLoadMore: 'Clicked “$1” to load more',
    logLoadedMore: 'Loaded more (rows: $1 → $2)',
    logScrollToEnd: 'Scrolling to the end of the list to load more (rows: $1)',
    durationSec: '$1s',
    durationMin: '$1m $2s',
    runStartAll: 'Start',
    runStartN: 'Link delete $1 only',
    logRunStart: '▶ $1 (v$2, targets: $3, interval: $4ms, rows shown: $5, $6)',
    logSkipRepeated: 'Skipped a row processed $1 times: $2',
    reasonRepeated: 'not finished after $1 attempts',
    logSkipNoButton: 'Skipped a row without a “…” button: $1',
    reasonNoButton: 'no “…” button',
    logDeleted: '✓ Link deleted (#$1, $2s)',
    logNotice: 'Dropbox notice: $1',
    logUndecidableKind: 'Cannot tell view and edit links apart in this Dropbox language; enable both Targets: $1 (menu: $2)',
    reasonUndecidableKind: 'view / edit cannot be told apart in this language',
    logWaitingForList: 'Waiting for the link list to load…',
    logListReady: 'Link list loaded ($1 rows, $2s)',
    logListNotReady: 'Link list did not appear within $1s; continuing with the rows found',
    logRowStillListed: 'Row still listed after the deletion; checking it again: $1',
    reasonFailedN: 'failed $1 times: $2',
    logTooManyFailures: 'Stopped after $1 failures in a row. Check the “$2” output.', // $2: Diagnose button label
    logError: 'Error: $1',
    logErrorWhere: '  at: $1',
    endNoTargetsLeft: 'no targets in the remaining rows',
    endNoRows: 'no rows found',
    endTooManyFailures: 'repeated failures',
    endDeletedN: '$1 link deleted',
    endError: 'error',
    endStopButton: '“$1” button', // $1: Stop button label
    endUnknown: 'unknown',
    logRunEnd: '■ Finished ($1): links deleted $2 / skipped $3 rows / failed $4 times / $5',
    logSkippedRow: '  skipped: $1 — $2',
    logSkippedMore: '  …and $1 more rows',
    diagStart: '--- Diagnose ---',
    diagRows: 'Data rows: $1',
    diagRowLike: 'Row-like elements (including headers): $1',
    diagFirstRow: 'First row: $1',
    diagButtonsBefore: 'Buttons in the row before hover: $1',
    diagButtonsAfter: 'Buttons in the row after hover: $1',
    diagNoMoreButton: '→ Could not identify the “…” button',
    diagUseMoreButton: '→ Using as the “…” button: $1',
    diagMenuNotDetected: 'No menu detected after clicking “…”',
    diagOpenMenus: 'Open menu elements: $1',
    diagMenuItems: 'Menu items: $1',
    diagTarget: '→ Menu item for the link deletion: “$1”',
    diagNoTarget: '→ No menu item for a link deletion found',
    diagEnd: '--- Diagnose finished (no links were deleted) ---',
    diagMenu: 'Menu: $1',
    diagOpenDialog: 'Opening the confirmation dialog of “$1” to inspect it (it will be closed without confirming)',
    diagDialog: 'Confirmation dialog: $1',
    diagDialogNotOpened: 'No confirmation dialog appeared',
    diagConfirmChoice: '→ Button that would confirm: “$1”',
    diagNoConfirmChoice: '→ No button would be pressed to confirm',
    diagDialogClosed: 'Confirmation dialog closed without confirming',
    diagDialogStillOpen: 'The confirmation dialog is still open; close it with its cancel button. Do not confirm',
    logUserActivity: 'User activity detected ($1); stopping',
    endUserActivity: 'user activity',
    kindView: 'view links',
    kindEdit: 'edit links',
  };
  const L = (key, ...subs) => format(LOG_MESSAGES[key] ?? key, subs);

  // ---- Utilities ----
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const textOf = (el) => norm(el && (el.innerText || el.textContent));
  const labelOf = (el) =>
    norm([el.getAttribute('aria-label'), el.getAttribute('title'), textOf(el)].filter(Boolean).join(' '));

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  }

  const isDisabled = (el) => el.disabled || el.getAttribute('aria-disabled') === 'true';

  // Polls fn() until it returns a truthy value. Gives up early on stop unless abortOnStop is false.
  async function waitFor(fn, timeout = DEFAULT_WAIT_TIMEOUT_MS, { abortOnStop = true } = {}) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (abortOnStop && stopRequested) return null;
      const v = fn();
      if (v) return v;
      await sleep(POLL_INTERVAL_MS);
    }
    return null;
  }

  function simpleClick(el) {
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    el.focus?.({ preventScroll: true });
    el.click();
  }

  // For menus that open on pointerdown rather than click
  function pointerClick(el) {
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    const opts = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true,
    };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('click', { ...opts, buttons: 0 }));
  }

  function pressEscape() {
    const target = document.activeElement || document.body;
    const opts = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true };
    target.dispatchEvent(new KeyboardEvent('keydown', opts));
    target.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  // Dropbox's cancel / close button of a dialog (any language), else one labelled like "Cancel"
  const findCancelButton = (dialog) =>
    [...dialog.querySelectorAll(CANCEL_BUTTON_SELECTOR)].find(isVisible) ||
    [...dialog.querySelectorAll('button, [role="button"]')].find((b) => isVisible(b) && CANCEL_RE.test(labelOf(b)));

  async function closeOverlays() {
    for (let i = 0; i < MAX_ESCAPE_PRESSES && (getOpenMenus().length || getOpenDialogs().length); i++) {
      pressEscape();
      await sleep(ESCAPE_WAIT_MS);
    }
    // A dialog that ignores Escape is closed with its cancel button (never its confirm button)
    for (const d of getOpenDialogs()) {
      const cancel = findCancelButton(d);
      if (cancel) {
        simpleClick(cancel);
        await sleep(ESCAPE_WAIT_MS);
      }
    }
  }

  // ---- Element lookup ----
  const rowKey = (row) => textOf(row).slice(0, ROW_KEY_LENGTH);
  const preview = (text) => (text.length > LOG_PREVIEW_LENGTH ? text.slice(0, LOG_PREVIEW_LENGTH) + '…' : text);

  function isInChrome(el) {
    return !!el.closest('header, nav, [role="banner"], [role="navigation"], aside, ' + MENU_SELECTOR + ', ' + DIALOG_SELECTOR);
  }

  // Header rows (with sort buttons etc.) are not targets
  const isHeaderRow = (row) =>
    !!(row.closest('thead') || row.querySelector('[role="columnheader"], th'));

  // Data rows of the link list
  function findRows() {
    const pick = (sel) =>
      [...document.querySelectorAll(sel)].filter(
        (r) => isVisible(r) && !isHeaderRow(r) && !isInChrome(r) && textOf(r)
      );
    let rows = pick('[role="row"], tr');
    if (!rows.length) rows = pick('[role="listitem"], [data-testid*="row" i]');
    // Sidebar entries ("すべてのファイル", "写真", ...) can be rows too. Once Dropbox's "…" button has been
    // seen, only rows carrying it are list rows.
    const withMenu = rows.filter((r) => r.querySelector(`[data-testid="${MORE_BUTTON_TESTID}"]`));
    if (withMenu.length) sawMoreButtonRows = true;
    return sawMoreButtonRows ? withMenu : rows;
  }
  let sawMoreButtonRows = false;

  // When started while Dropbox is still loading, wait for the list (rows with the "…" button) to appear
  async function waitForList() {
    const ready = () => findRows().length && sawMoreButtonRows;
    if (ready()) return;
    log(L('logWaitingForList'), 'muted');
    const startedAt = Date.now();
    if (await waitFor(ready, LIST_READY_TIMEOUT_MS)) {
      log(L('logListReady', findRows().length, ((Date.now() - startedAt) / 1000).toFixed(1)), 'muted');
    } else if (!stopRequested) {
      log(L('logListNotReady', LIST_READY_TIMEOUT_MS / 1000), 'warn');
    }
  }

  // Tracks handled rows during a run. Rows are told apart by element, so rows with the same name and date
  // are handled separately. If Dropbox re-renders a given-up row as a new element, the per-name count stops
  // it from being retried forever: a name is given up once it has as many give-ups as rows currently listed.
  function createRowTracker() {
    const state = new WeakMap(); // row element -> { attempts, lastDeleted, skipped }
    const giveUps = new Map(); // row key -> number of rows with that key given up
    const reasons = new Map(); // row key -> reason, for the end-of-run summary
    let skippedCount = 0;
    const of = (row) => {
      let st = state.get(row);
      if (!st) state.set(row, (st = { attempts: 0, lastDeleted: null, skipped: false }));
      return st;
    };
    return {
      of,
      skip(row, reason) {
        const st = of(row);
        if (st.skipped) return;
        st.skipped = true;
        skippedCount++;
        const key = rowKey(row);
        giveUps.set(key, (giveUps.get(key) || 0) + 1);
        reasons.set(key, reason);
      },
      isSkipped(row, rows) {
        if (state.get(row)?.skipped) return true;
        const key = rowKey(row);
        const given = giveUps.get(key);
        return !!given && given >= rows.filter((r) => rowKey(r) === key).length;
      },
      nextRow() {
        const rows = findRows();
        return rows.find((r) => !this.isSkipped(r, rows)) || null;
      },
      get skippedCount() {
        return skippedCount;
      },
      reasons,
    };
  }

  // The "…" button may only be shown on hover, so check its size and ignore opacity / visibility
  const hasBox = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  function looksLikeMore(b) {
    const aria = norm([b.getAttribute('aria-label'), b.getAttribute('title')].join(' '));
    const text = textOf(b);
    if (MORE_TEXT_RE.test(text)) return true;
    return !!aria && MORE_LABEL_RE.test(aria) && text.length <= 3;
  }

  function moreButtonIn(row) {
    const buttons = [...row.querySelectorAll('button, [role="button"]')].filter(
      (b) => hasBox(b) && !isDisabled(b)
    );
    return (
      buttons.find((b) => b.getAttribute('data-testid') === MORE_BUTTON_TESTID) ||
      buttons.find(looksLikeMore) ||
      buttons.reverse().find((b) => b.hasAttribute('aria-haspopup') && textOf(b).length <= 3) ||
      null
    );
  }

  function hover(el) {
    const r = el.getBoundingClientRect();
    const opts = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerType: 'mouse', isPrimary: true,
    };
    el.dispatchEvent(new PointerEvent('pointerover', opts));
    el.dispatchEvent(new PointerEvent('pointerenter', { ...opts, bubbles: false }));
    el.dispatchEvent(new MouseEvent('mouseover', opts));
    el.dispatchEvent(new MouseEvent('mouseenter', { ...opts, bubbles: false }));
    el.dispatchEvent(new PointerEvent('pointermove', opts));
    el.dispatchEvent(new MouseEvent('mousemove', opts));
  }

  // Find the row's "…" button; if absent, hover the row and wait for it to appear
  async function findMoreButtonInRow(row) {
    let btn = moreButtonIn(row);
    if (btn) return btn;
    row.scrollIntoView({ block: 'center' });
    hover(row);
    btn = await waitFor(() => row.isConnected && moreButtonIn(row), HOVER_WAIT_MS);
    return btn || null;
  }

  function getOpenMenus() {
    return [...document.querySelectorAll(MENU_SELECTOR)].filter(isVisible);
  }

  // Visible menu items, excluding `ignore` (items that were already on screen, e.g. the page header's
  // always-visible menubar entries such as "ストレージを追加" or the account avatar)
  function getMenuItems(ignore = new Set()) {
    const menus = getOpenMenus();
    let items = [];
    for (const m of menus) items.push(...m.querySelectorAll(MENU_ITEM_SELECTOR));
    if (!items.length) {
      items = [...document.querySelectorAll(MENU_ITEM_SELECTOR)];
    }
    if (!items.length) {
      for (const m of menus) items.push(...m.querySelectorAll('button, a, li'));
    }
    return [...new Set(items)].filter((el) => !ignore.has(el) && isVisible(el) && textOf(el));
  }

  function getOpenDialogs() {
    return [...document.querySelectorAll(DIALOG_SELECTOR)].filter(
      (d) => isVisible(d) && !d.querySelector('[role="menuitem"]')
    );
  }

  // Only dialogs about links are confirmed, so an unexpected dialog (e.g. deleting a file) is never accepted
  function findConfirmButton() {
    for (const d of getOpenDialogs()) {
      if (!LINK_RE.test(textOf(d))) continue;
      // Dropbox's own modal: its primary button, whatever the language
      if (d.matches(CONFIRM_DIALOG_SELECTOR)) {
        const primary = [...d.querySelectorAll(CONFIRM_BUTTON_SELECTOR)].find((b) => isVisible(b) && !isDisabled(b));
        if (primary) return primary;
      }
      // Otherwise a delete-like button (Japanese / English wording)
      const buttons = [...d.querySelectorAll('button, [role="button"]')].filter((b) => {
        if (!isVisible(b) || isDisabled(b)) return false;
        const l = labelOf(b);
        return DELETE_RE.test(l) && !CANCEL_RE.test(l);
      });
      if (buttons.length) return buttons[buttons.length - 1];
    }
    return null;
  }

  // The class-based match of a link-deletion menu item: { kind } with kind 'view' / 'edit' or null when unknown
  function linkItemMarker(el) {
    for (const c of el.classList) {
      const m = c.match(DELETE_LINK_ITEM_CLASS_RE);
      if (m) {
        const l = labelOf(el);
        // The kind comes from the class when it says so, else from the (Japanese / English) text
        return { kind: m[1] || (VIEW_RE.test(l) ? 'view' : EDIT_RE.test(l) ? 'edit' : null) };
      }
    }
    return null;
  }

  // A link-deletion item whose kind cannot be told in this language, while only one of the Targets is enabled
  const isUndecidableItem = (el) => {
    const marker = linkItemMarker(el);
    return !!marker && !marker.kind && !(settings.view && settings.edit);
  };

  // Pick the menu item to delete
  function pickDeleteItem(items) {
    let best = null;
    for (const el of items) {
      if (isDisabled(el)) continue;
      const l = labelOf(el);
      let kind = null;
      let score = 0;
      const marker = linkItemMarker(el);
      if (marker) {
        // Dropbox's own class: works in every language. An unknown kind is only taken when both kinds are targets.
        if (marker.kind ? !settings[marker.kind] : !(settings.view && settings.edit)) continue;
        kind = marker.kind || 'link';
        score = 4;
        if (!best || score > best.score) best = { el, kind, score, label: textOf(el) };
        continue;
      }
      if (VIEW_RE.test(l)) kind = 'view';
      else if (EDIT_RE.test(l)) kind = 'edit';

      if (kind) {
        if (!settings[kind]) continue;
        if (DELETE_RE.test(l)) score = 3;
        else if (NON_DELETE_RE.test(l)) continue;
        else score = 2;
      } else if (GENERIC_DELETE_LINK_RE.test(l) && settings.view && settings.edit) {
        score = 1;
        kind = 'link';
      }
      if (score && (!best || score > best.score)) best = { el, kind, score, label: textOf(el) };
    }
    return best;
  }

  function findLoadMoreButton() {
    return [...document.querySelectorAll('button, [role="button"], a')].find(
      (b) => isVisible(b) && !isDisabled(b) && LOAD_MORE_RE.test(labelOf(b))
    );
  }

  // ---- Actions ----
  // Only items that appear after the click count as the opened menu
  async function openMenu(btn) {
    await closeOverlays();
    const before = new Set(getMenuItems());
    const opened = () => { const i = getMenuItems(before); return i.length ? i : null; };
    simpleClick(btn);
    let items = await waitFor(opened, MENU_OPEN_TIMEOUT_MS);
    if (!items && !stopRequested) {
      pointerClick(btn);
      items = await waitFor(opened, MENU_OPEN_TIMEOUT_MS);
    }
    return items;
  }

  // Snapshot of open menus / dialogs, logged when a step fails
  function describeOverlays() {
    const menus = getOpenMenus();
    const dialogs = getOpenDialogs();
    const parts = [L('overlaySummary', menus.length, dialogs.length)];
    const items = getMenuItems();
    if (items.length) parts.push(L('overlayMenuItems', items.map((i) => `"${textOf(i)}"`).join(', ')));
    dialogs.forEach((d, i) => {
      const buttons = [...d.querySelectorAll('button, [role="button"]')].filter(isVisible).map((b) => `"${labelOf(b)}"`);
      parts.push(L('overlayDialog', i, preview(textOf(d)), buttons.join(', ') || L('none')));
    });
    return parts.join(' | ');
  }

  // Toasts / alerts Dropbox shows after an action (e.g. success or error messages)
  const currentNotices = () =>
    [...document.querySelectorAll(NOTICE_SELECTOR)].filter(isVisible).map(textOf).filter(Boolean);
  // A notice that was not on screen before the confirm button was pressed
  const findNewNotice = (baseline) => currentNotices().find((t) => !baseline.has(t)) || null;

  // Returns 'deleted' | 'nothing' | 'failed' | 'stopped'
  async function processOne(btn, rowLabel, lastDeletedLabel) {
    const items = await openMenu(btn);
    if (stopRequested) return { result: 'stopped' };
    if (!items) {
      log(L('logMenuNotOpened', rowLabel, describeOverlays()), 'warn');
      return { result: 'failed', reason: L('reasonMenuNotOpened') };
    }

    const target = pickDeleteItem(items);
    if (!target) {
      const menuText = items.map(textOf).join(' / ');
      if (items.some(isUndecidableItem)) {
        log(L('logUndecidableKind', rowLabel, menuText), 'warn');
        await closeOverlays();
        return { result: 'nothing', reason: L('reasonUndecidableKind') };
      }
      log(L('logNothingToDelete', rowLabel, menuText), 'muted');
      await closeOverlays();
      return { result: 'nothing', reason: L('reasonNothingToDelete', menuText) };
    }
    if (target.label === lastDeletedLabel) {
      log(L('logStillShown', target.label), 'warn');
    }

    log(L('logSelectItem', target.label, rowLabel));
    simpleClick(target.el);
    let confirmBtn = await waitFor(findConfirmButton, DIALOG_OPEN_TIMEOUT_MS);

    if (!confirmBtn && !stopRequested && target.el.isConnected && isVisible(target.el)) {
      log(L('logRetryPointer'), 'muted');
      pointerClick(target.el);
      confirmBtn = await waitFor(findConfirmButton, DIALOG_OPEN_TIMEOUT_MS);
    }

    // Fallback: the item opens a submenu. Only an item that explicitly deletes a link of an enabled kind
    // ("閲覧リンクを削除", "Delete link", ...) is accepted; a bare "Delete" or "ファイルを削除" is never clicked.
    if (!confirmBtn && !stopRequested) {
      const rest = getMenuItems().filter((i) => i !== target.el);
      const sub = pickDeleteItem(rest);
      if (sub && DELETE_RE.test(sub.label)) {
        log(L('logSelectSubmenu', sub.label));
        simpleClick(sub.el);
        confirmBtn = await waitFor(findConfirmButton, SUBMENU_DIALOG_TIMEOUT_MS);
      } else {
        const ignored = rest.filter((i) => DELETE_RE.test(labelOf(i))).map((i) => `"${textOf(i)}"`);
        if (ignored.length) log(L('logSubmenuIgnored', ignored.join(', ')), 'warn');
      }
    }

    if (stopRequested) return { result: 'stopped' };
    if (!confirmBtn) {
      log(L('logNoConfirmButton', describeOverlays()), 'warn');
      await closeOverlays();
      return { result: 'failed', reason: L('reasonNoConfirmButton') };
    }

    await sleep(CONFIRM_SETTLE_MS);
    const noticeBaseline = new Set(currentNotices());
    log(L('logClickConfirm', textOf(confirmBtn)));
    simpleClick(confirmBtn);

    // The deletion is already sent, so keep waiting for its result even if Stop is pressed meanwhile
    const closed = await waitFor(() => !isVisible(confirmBtn), DIALOG_CLOSE_TIMEOUT_MS, { abortOnStop: false });
    if (!closed) {
      log(L('logDialogNotClosed', describeOverlays()), 'warn');
      await closeOverlays();
      return { result: 'failed', reason: L('reasonDialogNotClosed') };
    }
    return { result: 'deleted', label: target.label, noticeBaseline };
  }

  // Load more of the list. Returns true if unprocessed rows appear
  async function loadMore(tracker) {
    const hasCandidates = () => !!tracker.nextRow();
    const before = findRows().length;

    const btn = findLoadMoreButton();
    if (btn) {
      log(L('logClickLoadMore', textOf(btn)));
      simpleClick(btn);
      if (await waitFor(hasCandidates, LOAD_MORE_TIMEOUT_MS)) {
        log(L('logLoadedMore', before, findRows().length), 'muted');
        return true;
      }
    }

    log(L('logScrollToEnd', before), 'muted');
    window.scrollTo(0, document.documentElement.scrollHeight);
    for (const el of document.querySelectorAll('*')) {
      if (el.scrollHeight > el.clientHeight + SCROLLABLE_MIN_OVERFLOW_PX) {
        const oy = getComputedStyle(el).overflowY;
        if (oy === 'auto' || oy === 'scroll') el.scrollTop = el.scrollHeight;
      }
    }
    const found = !!(await waitFor(hasCandidates, SCROLL_LOAD_TIMEOUT_MS));
    if (found) log(L('logLoadedMore', before, findRows().length), 'muted');
    return found;
  }

  const formatDuration = (ms) => {
    const sec = Math.round(ms / 1000);
    return sec < 60 ? L('durationSec', sec) : L('durationMin', Math.floor(sec / 60), sec % 60);
  };

  const selectedKinds = () =>
    [settings.view && t('kindView'), settings.edit && t('kindEdit')].filter(Boolean).join(t('kindSeparator'));

  function onUserActivity(e) {
    if (!e.isTrusted || !running || stopRequested) return;
    if (e.composedPath().includes(host)) return;
    stopRequested = true;
    stoppedByUser = true;
    log(L('logUserActivity', e.type), 'warn');
  }

  async function run(maxCount = Infinity) {
    if (running || !contextValid()) return;
    running = true;
    stopRequested = false;
    stoppedByUser = false;
    $('alert').hidden = true;
    USER_ACTIVITY_EVENTS.forEach((type) => window.addEventListener(type, onUserActivity, { capture: true, passive: true }));
    updateUI();
    const tracker = createRowTracker();
    await waitForList();
    const startedAt = Date.now();
    let deleted = 0;
    let failures = 0;
    let consecutiveFailures = 0;
    let endReason = '';

    log(
      L(
        'logRunStart',
        maxCount === Infinity ? L('runStartAll') : L('runStartN', maxCount),
        chrome.runtime.getManifest().version,
        [settings.view && L('kindView'), settings.edit && L('kindEdit')].filter(Boolean).join(' and '),
        settings.delay,
        findRows().length,
        location.pathname
      )
    );
    try {
      while (!stopRequested && deleted < maxCount) {
        const row = tracker.nextRow();
        if (!row) {
          if (await loadMore(tracker)) continue;
          endReason = tracker.skippedCount ? L('endNoTargetsLeft') : L('endNoRows');
          break;
        }

        const rowLabel = preview(rowKey(row));
        const st = tracker.of(row);
        const n = ++st.attempts;
        if (n > MAX_ATTEMPTS_PER_ROW) {
          log(L('logSkipRepeated', MAX_ATTEMPTS_PER_ROW, rowLabel), 'warn');
          tracker.skip(row, L('reasonRepeated', MAX_ATTEMPTS_PER_ROW));
          continue;
        }

        const btn = await findMoreButtonInRow(row);
        if (stopRequested) break;
        if (!btn) {
          log(L('logSkipNoButton', rowLabel), 'muted');
          tracker.skip(row, L('reasonNoButton'));
          continue;
        }

        const itemStartedAt = Date.now();
        const { result, reason, label, noticeBaseline } = await processOne(btn, rowLabel, st.lastDeleted);
        if (result === 'stopped') break;
        if (result === 'deleted') {
          deleted++;
          deletedTotal++;
          consecutiveFailures = 0;
          st.lastDeleted = label;
          log(L('logDeleted', deletedTotal, ((Date.now() - itemStartedAt) / 1000).toFixed(1)), 'ok');
          updateUI();
          // Use the wait between deletions to pick up Dropbox's toast (success / error message)
          const waitStartedAt = Date.now();
          const notice = await waitFor(() => findNewNotice(noticeBaseline), settings.delay);
          if (notice) log(L('logNotice', preview(notice)), 'muted');
          await sleep(Math.max(0, settings.delay - (Date.now() - waitStartedAt)));
          // Clicking a row that is about to disappear opens nothing, so wait until Dropbox drops it.
          // A row that stays has more links (e.g. an edit link after its view link) and is processed again.
          if (!(await waitFor(() => !row.isConnected || !isVisible(row), ROW_REMOVAL_TIMEOUT_MS))) {
            if (!stopRequested) log(L('logRowStillListed', rowLabel), 'muted');
          }
          continue;
        }
        if (result === 'nothing') {
          tracker.skip(row, reason);
          consecutiveFailures = 0;
        } else {
          failures++;
          consecutiveFailures++;
          if (n >= FAILURES_BEFORE_ROW_SKIP) tracker.skip(row, L('reasonFailedN', n, reason));
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            log(L('logTooManyFailures', MAX_CONSECUTIVE_FAILURES, t('uiDiagnose')), 'warn');
            endReason = L('endTooManyFailures');
            break;
          }
        }
        await sleep(settings.delay);
      }
      if (!endReason && deleted >= maxCount) endReason = L('endDeletedN', maxCount);
    } catch (e) {
      endReason = L('endError');
      log(L('logError', e?.message), 'warn');
      const where = (e?.stack || '').split('\n').slice(1, 3).map((s) => s.trim()).join(' ← ');
      if (where) log(L('logErrorWhere', where), 'warn');
      console.error('[DLR]', e);
    } finally {
      USER_ACTIVITY_EVENTS.forEach((type) => window.removeEventListener(type, onUserActivity, { capture: true }));
      if (stoppedByUser) endReason = L('endUserActivity');
      else if (stopRequested) endReason = L('endStopButton', t('uiStop'));
      $('alert').hidden = !stoppedByUser;
      log(
        L('logRunEnd', endReason || L('endUnknown'), deleted, tracker.skippedCount, failures, formatDuration(Date.now() - startedAt)),
        deleted ? 'ok' : ''
      );
      const reasons = [...tracker.reasons];
      reasons.slice(0, SKIPPED_LIST_MAX).forEach(([key, why]) => log(L('logSkippedRow', preview(key), why), 'muted'));
      if (reasons.length > SKIPPED_LIST_MAX) log(L('logSkippedMore', reasons.length - SKIPPED_LIST_MAX), 'muted');
      running = false;
      stopRequested = false;
      updateUI();
    }
  }

  // Every attribute of an element (except style), to find language-independent markers such as data-testid
  const describeElement = (el) => {
    // Dropbox's generated "dig-…" classes hide the meaningful ones (e.g. "delete-link"), so those are only counted
    const classValue = (value) => {
      const all = value.split(/\s+/).filter(Boolean);
      const generated = all.filter((c) => c.startsWith('dig-')).length;
      return [...all.filter((c) => !c.startsWith('dig-')), generated ? `+${generated} dig-*` : ''].filter(Boolean).join(' ');
    };
    const attrs = [...el.attributes]
      .filter((a) => a.name !== 'style')
      .map((a) => `${a.name}="${preview(a.name === 'class' ? classValue(a.value) : a.value)}"`)
      .join(' ');
    return `<${el.tagName.toLowerCase()}${attrs ? ' ' + attrs : ''}> "${preview(textOf(el))}"`;
  };

  // Opens the confirmation dialog of `item`, logs its structure and closes it again without confirming
  async function inspectConfirmDialog(item) {
    log(L('diagOpenDialog', textOf(item)));
    simpleClick(item);
    const dialog = await waitFor(() => getOpenDialogs()[0], DIALOG_OPEN_TIMEOUT_MS);
    if (!dialog) {
      log(L('diagDialogNotOpened'), 'warn');
      return;
    }
    log(L('diagDialog', describeElement(dialog)));
    [...dialog.querySelectorAll('button, [role="button"]')].filter(isVisible).forEach((b, i) => log(`  [${i}] ${describeElement(b)}`));
    const confirmBtn = findConfirmButton();
    log(confirmBtn ? L('diagConfirmChoice', textOf(confirmBtn)) : L('diagNoConfirmChoice'), confirmBtn ? 'ok' : 'warn');

    // Close without confirming: Escape first, then a cancel-like button
    pressEscape();
    let closed = await waitFor(() => !dialog.isConnected || !isVisible(dialog), DIAGNOSE_DIALOG_CLOSE_MS, { abortOnStop: false });
    if (!closed) {
      const cancel = findCancelButton(dialog);
      if (cancel) simpleClick(cancel);
      closed = await waitFor(() => !dialog.isConnected || !isVisible(dialog), DIAGNOSE_DIALOG_CLOSE_MS, { abortOnStop: false });
    }
    log(closed ? L('diagDialogClosed') : L('diagDialogStillOpen'), closed ? 'muted' : 'warn');
  }

  const describeButton = (b) => {
    const cs = getComputedStyle(b);
    return `<${b.tagName.toLowerCase()}> aria-label="${b.getAttribute('aria-label') || ''}" title="${b.getAttribute('title') || ''}" ` +
      `haspopup=${b.getAttribute('aria-haspopup')} text="${textOf(b).slice(0, LOG_PREVIEW_LENGTH)}" testid="${b.getAttribute('data-testid') || ''}" ` +
      `opacity=${cs.opacity} visibility=${cs.visibility}`;
  };

  // Log the detected DOM structure (for troubleshooting); deletes nothing
  async function diagnose() {
    if (running || !contextValid()) return;
    running = true;
    updateUI();
    try {
      log(L('diagStart'));
      await waitForList();
      const rows = findRows();
      log(L('diagRows', rows.length));
      if (!rows.length) {
        const rowLike = document.querySelectorAll('[role="row"], tr, [role="listitem"], [role="grid"], [role="table"], table');
        log(L('diagRowLike', rowLike.length));
        return;
      }
      const row = rows[0];
      log(L('diagFirstRow', `<${row.tagName.toLowerCase()} role=${row.getAttribute('role')}> ${preview(rowKey(row))}`));
      const listButtons = (messageKey) => {
        const bs = [...row.querySelectorAll('button, [role="button"]')];
        log(L(messageKey, bs.length));
        bs.slice(0, DIAGNOSE_MAX_BUTTONS).forEach((b, i) => log(`  [${i}] ${describeButton(b)}`));
      };
      listButtons('diagButtonsBefore');
      row.scrollIntoView({ block: 'center' });
      hover(row);
      await sleep(DIAGNOSE_HOVER_WAIT_MS);
      listButtons('diagButtonsAfter');

      const btn = moreButtonIn(row);
      if (!btn) {
        log(L('diagNoMoreButton'), 'warn');
        return;
      }
      log(L('diagUseMoreButton', describeButton(btn)), 'ok');
      const items = await openMenu(btn);
      if (!items) {
        log(L('diagMenuNotDetected'), 'warn');
        log(L('diagOpenMenus', getOpenMenus().length));
        return;
      }
      log(L('diagMenuItems', items.map((i) => `"${textOf(i)}"(${i.getAttribute('role') || i.tagName.toLowerCase()})`).join(', ')));
      items.forEach((i, n) => log(`  [${n}] ${describeElement(i)}`));
      const menu = items[0].closest('[role="menu"], [role="listbox"]'); // Dropbox's item rows also match MENU_SELECTOR
      if (menu) log(L('diagMenu', describeElement(menu)));
      const target = pickDeleteItem(items);
      log(target ? L('diagTarget', target.label) : L('diagNoTarget'), target ? 'ok' : 'warn');
      // Only a recognized link-deletion item is opened; an unknown language's items are just listed
      if (target) await inspectConfirmDialog(target.el);
      await closeOverlays();
      log(L('diagEnd'));
    } finally {
      running = false;
      updateUI();
    }
  }

  // ---- Panel styles ----
  // Design tokens are defined once on :host; components below only reference tokens.
  // Dark mode overrides color and shadow tokens only.
  const PANEL_CSS = `
    /* ===== Tokens ===== */
    :host {
      all: initial;

      /* Color */
      --color-bg: #ffffff;
      --color-surface-subtle: #f5f3f0;
      --color-fg: #1e1919;
      --color-fg-muted: #736e69;
      --color-border: #e6e2dd;
      --color-border-strong: #bdb7b0;
      --color-accent: #0061fe;
      --color-on-accent: #ffffff;
      --color-tint-bg: #e8f0ff;
      --color-tint-bg-hover: #d6e4ff;
      --color-tint-fg: #0050d4;
      --color-danger: #ff3366;
      --color-danger-hover: #e62e5c;
      --color-on-danger: #ffffff;
      --color-success: #1a7f37;
      --color-warning: #ff3366;
      --color-focus: var(--color-accent);
      --color-logo-shield: var(--color-accent);
      --color-logo-mark: #ffffff;
      --color-scrollbar-thumb: rgba(0,0,0,.32);
      --color-scrollbar-thumb-hover: rgba(0,0,0,.48);

      /* Typography — Latin letters, digits and symbols use Roboto; Japanese falls through to Noto Sans JP */
      --font-family: "Roboto", "Noto Sans JP", sans-serif;
      --font-size-xs: 11px;
      --font-size-sm: 12px;
      --font-size-md: 13px;
      --font-size-lg: 14px;
      --font-weight-regular: 400;
      --font-weight-medium: 500;
      --font-weight-bold: 700;
      --line-height-base: 1.5;
      --line-height-relaxed: 1.65;
      --letter-spacing-title: .01em;

      /* Spacing (2px steps) */
      --space-1: 2px;
      --space-2: 4px;
      --space-3: 6px;
      --space-4: 8px;
      --space-5: 10px;
      --space-6: 12px;
      --space-7: 14px;
      --space-10: 20px;

      /* Radius */
      --radius-sm: 5px;
      --radius-md: 8px;
      --radius-lg: 10px;
      --radius-xl: 14px;
      --radius-full: 999px;

      /* Size */
      --panel-width: 372px;
      --panel-inset: var(--space-10);
      --label-column-width: 72px;
      --control-height: 30px;
      --icon-button-size: 28px;
      --logo-size: 22px;
      --icon-size: 14px;
      --checkbox-size: 16px;
      --check-mark-size: 10px;
      --spinner-size: 11px;
      --dot-size: 7px;
      --log-height: 168px;
      --scrollbar-size: 10px; /* track; the visible thumb is this minus twice the inset (4px) */
      --scrollbar-thumb-inset: 3px; /* gap between the thumb and the log's edges */

      /* Border */
      --border-width: 1px;
      --border-width-strong: 1.5px;
      --spinner-width: 2px;
      --focus-ring-width: 2px;
      --focus-ring-offset: 2px;

      /* Opacity */
      --opacity-disabled: .4;
      --opacity-timestamp: .7;

      /* Motion */
      --duration-press: .05s;
      --duration-fast: .15s;
      --duration-medium: .2s;
      --duration-spin: .7s;
      --duration-pulse: 1.2s;
      --easing-standard: ease;
      --press-offset: 1px;

      /* Elevation */
      --shadow-panel: 0 1px 2px rgba(0,0,0,.06), 0 16px 40px rgba(0,0,0,.16);
      --z-panel: 2147483647;
    }
    @media (prefers-color-scheme: dark) {
      :host {
        --color-bg: #1f1e1d;
        --color-surface-subtle: #2a2928;
        --color-fg: #f3f1ee;
        --color-fg-muted: #a29d97;
        --color-border: #353331;
        --color-border-strong: #6a655f;
        --color-tint-bg: #1c2a45;
        --color-tint-bg-hover: #233558;
        --color-tint-fg: #8db6ff;
        --color-success: #5ccf78;
        --color-scrollbar-thumb: rgba(255,255,255,.32);
        --color-scrollbar-thumb-hover: rgba(255,255,255,.48);
        --shadow-panel: 0 1px 2px rgba(0,0,0,.3), 0 16px 40px rgba(0,0,0,.5);
      }
    }

    /* ===== Base ===== */
    * { box-sizing: border-box; }
    .btn:focus-visible,
    .icon-btn:focus-visible { outline: var(--focus-ring-width) solid var(--color-focus); outline-offset: var(--focus-ring-offset); }

    /* ===== Panel ===== */
    .panel {
      position: fixed; right: var(--panel-inset); bottom: var(--panel-inset); z-index: var(--z-panel);
      width: var(--panel-width); max-width: calc(100vw - 2 * var(--panel-inset));
      font-family: var(--font-family); font-size: var(--font-size-md); font-weight: var(--font-weight-regular);
      line-height: var(--line-height-base); -webkit-font-smoothing: antialiased;
      color: var(--color-fg); background: var(--color-bg);
      border: var(--border-width) solid var(--color-border); border-radius: var(--radius-xl);
      box-shadow: var(--shadow-panel); overflow: hidden;
    }
    .panel:not(:lang(ja)) { --font-family: "Roboto", sans-serif; } /* Chinese / Korean use the system font for their own glyph forms */
    .panel.collapsed .body { display: none; }
    .panel.collapsed .head { border-bottom: 0; }

    /* ===== Header ===== */
    .head {
      display: flex; align-items: center; gap: var(--space-5);
      padding: var(--space-6) var(--space-5) var(--space-6) var(--space-7);
      border-bottom: var(--border-width) solid var(--color-border);
    }
    .logo { width: var(--logo-size); height: var(--logo-size); flex: none; }
    .logo-shield { fill: var(--color-logo-shield); }
    .logo-mark { fill: var(--color-logo-mark); }
    .title {
      flex: 1; display: flex; align-items: center; gap: var(--space-4);
      font-size: var(--font-size-lg); font-weight: var(--font-weight-bold); letter-spacing: var(--letter-spacing-title);
    }
    .dot {
      display: none; width: var(--dot-size); height: var(--dot-size); border-radius: var(--radius-full);
      background: var(--color-danger); animation: pulse var(--duration-pulse) var(--easing-standard) infinite;
    }
    .panel.running .dot { display: inline-block; }

    /* ===== Icon button ===== */
    .icon-btn {
      width: var(--icon-button-size); height: var(--icon-button-size); flex: none;
      display: grid; place-items: center; border: 0; border-radius: var(--radius-md);
      background: transparent; color: var(--color-fg-muted); cursor: pointer;
    }
    .icon-btn:hover { background: var(--color-surface-subtle); color: var(--color-fg); }
    .icon-btn svg { width: var(--icon-size); height: var(--icon-size); transition: transform var(--duration-medium) var(--easing-standard); }
    .panel.collapsed .icon-btn svg { transform: rotate(180deg); }

    /* ===== Layout ===== */
    .body { display: grid; gap: var(--space-6); padding: var(--space-7); }
    .grid { display: grid; grid-template-columns: minmax(var(--label-column-width), max-content) 1fr; align-items: center; gap: var(--space-5); }
    .label { color: var(--color-fg); font-size: var(--font-size-sm); font-weight: var(--font-weight-regular); white-space: nowrap; }
    .ctrl { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; min-width: 0; }

    /* ===== Counter ===== */
    .count {
      margin-bottom: calc(var(--space-4) - var(--space-6)); /* the body's gap is --space-6; the note sits --space-4 below */
      color: var(--color-fg-muted); font-size: var(--font-size-sm); white-space: nowrap; font-variant-numeric: tabular-nums;
    }
    .count-num { margin-right: var(--space-1); color: var(--color-fg); font-size: var(--font-size-lg); font-weight: var(--font-weight-regular); }

    /* ===== Chip (checkbox) ===== */
    .chip {
      position: relative; display: inline-flex; align-items: center; gap: var(--space-3);
      height: var(--control-height); padding: 0 var(--space-6) 0 var(--space-4);
      border: var(--border-width) solid var(--color-border); border-radius: var(--radius-full);
      background: var(--color-bg); cursor: pointer; user-select: none;
      transition: background var(--duration-fast), border-color var(--duration-fast);
    }
    .chip:hover { background: var(--color-surface-subtle); }
    .chip:has(input:checked) { background: var(--color-tint-bg); border-color: var(--color-tint-bg); }
    .chip:has(input:checked):hover { background: var(--color-tint-bg-hover); border-color: var(--color-tint-bg-hover); }
    .chip input { position: absolute; opacity: 0; pointer-events: none; }
    .chip .box {
      width: var(--checkbox-size); height: var(--checkbox-size); display: grid; place-items: center;
      border: var(--border-width-strong) solid var(--color-border-strong); border-radius: var(--radius-sm);
      color: var(--color-on-accent); transition: background var(--duration-fast), border-color var(--duration-fast);
    }
    .chip .box svg {
      width: var(--check-mark-size); height: var(--check-mark-size); opacity: 0; transform: scale(.5);
      transition: opacity var(--duration-fast), transform var(--duration-fast);
    }
    .chip input:checked + .box { background: var(--color-accent); border-color: var(--color-accent); }
    .chip input:checked + .box svg { opacity: 1; transform: scale(1); }
    .chip input:focus-visible + .box { outline: var(--focus-ring-width) solid var(--color-focus); outline-offset: var(--focus-ring-offset); }

    /* ===== Button ===== */
    .btn {
      appearance: none; display: inline-flex; align-items: center; gap: var(--space-3);
      height: var(--control-height); padding: 0 var(--space-6);
      border: var(--border-width) solid transparent; border-radius: var(--radius-md);
      font: inherit; font-size: var(--font-size-md); font-weight: var(--font-weight-medium); cursor: pointer;
      transition: background var(--duration-fast), border-color var(--duration-fast), opacity var(--duration-fast), transform var(--duration-press);
    }
    .btn:active:not(:disabled) { transform: translateY(var(--press-offset)); }
    .btn:disabled { opacity: var(--opacity-disabled); cursor: default; }
    .btn.busy:disabled { opacity: 1; }
    /* Variants */
    .btn.danger { background: var(--color-danger); color: var(--color-on-danger); }
    .btn.danger:hover:not(:disabled) { background: var(--color-danger-hover); }
    .btn.outline { background: var(--color-bg); border-color: var(--color-border); color: var(--color-fg); }
    .btn.outline:hover:not(:disabled) { background: var(--color-surface-subtle); }
    .btn.tint { background: var(--color-tint-bg); color: var(--color-tint-fg); }
    .btn.tint:hover:not(:disabled) { background: var(--color-tint-bg-hover); }
    /* Busy state */
    .spinner {
      display: none; width: var(--spinner-size); height: var(--spinner-size);
      border: var(--spinner-width) solid currentColor; border-right-color: transparent; border-radius: var(--radius-full);
      animation: spin var(--duration-spin) linear infinite;
    }
    .btn.busy .spinner { display: inline-block; }

    /* ===== Log ===== */
    .log-wrap { position: relative; min-width: 0; } /* min-width: 0 keeps long unwrapped lines from widening the panel */
    .log-copy {
      position: absolute; right: var(--scrollbar-size); bottom: var(--scrollbar-size); /* clear of both scrollbars */
      color: var(--color-accent); background: var(--color-surface-subtle);
    }
    .log-copy:hover { color: var(--color-accent); background: var(--color-tint-bg); }
    .log {
      height: var(--log-height); overflow: auto; padding: var(--space-4) var(--space-5);
      padding-bottom: calc(var(--icon-button-size) + var(--space-3)); /* keep the newest line clear of the copy icon */
      border-radius: var(--radius-lg); background: var(--color-surface-subtle);
      font-size: var(--font-size-xs); line-height: var(--line-height-relaxed); font-variant-numeric: tabular-nums;
      white-space: pre; /* no wrapping; long lines scroll horizontally */
    }
    /* Thin scrollbars (scrollbar-width must stay unset, or Chrome ignores these pseudo-elements) */
    .log::-webkit-scrollbar { width: var(--scrollbar-size); height: var(--scrollbar-size); }
    .log::-webkit-scrollbar-track, .log::-webkit-scrollbar-corner { background: transparent; }
    /* The far ends sit next to the corner; give the near ends the same gap so both ends match */
    .log::-webkit-scrollbar-track:horizontal { margin-left: var(--scrollbar-size); }
    .log::-webkit-scrollbar-track:vertical { margin-top: var(--scrollbar-size); }
    .log::-webkit-scrollbar-thumb {
      background: var(--color-scrollbar-thumb) padding-box; /* the transparent border insets the thumb */
      border: var(--scrollbar-thumb-inset) solid transparent; border-radius: var(--radius-full);
    }
    .log::-webkit-scrollbar-thumb:hover { background: var(--color-scrollbar-thumb-hover) padding-box; }
    .log .t { margin-right: var(--space-3); color: var(--color-fg-muted); opacity: var(--opacity-timestamp); }
    .log .ok { color: var(--color-success); }
    .log .warn { color: var(--color-warning); }
    .log .muted { color: var(--color-fg-muted); }

    /* ===== Note & alert ===== */
    .note { display: flex; gap: var(--space-3); align-items: flex-start; color: var(--color-fg-muted); font-size: var(--font-size-sm); }
    .note svg { width: var(--icon-size); height: var(--icon-size); flex: none; margin-top: var(--space-1); }
    .alert {
      margin-top: calc(-1 * var(--space-3)); padding-left: calc(var(--icon-size) + var(--space-3));
      color: var(--color-warning); font-size: var(--font-size-sm); font-weight: var(--font-weight-medium);
    }
    .alert[hidden] { display: none; }

    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
  `;

  // ---- UI (in a shadow root, isolated from the page's styles) ----
  // Lucide icons (ISC license): https://lucide.dev/icons/copy, https://lucide.dev/icons/check
  const LUCIDE_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
  const COPY_ICON = `<svg ${LUCIDE_ATTRS}><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;
  const COPIED_ICON = `<svg ${LUCIDE_ATTRS}><path d="M20 6 9 17l-5-5"/></svg>`;
  const CHECK_SVG = '<svg viewBox="0 0 12 12" fill="none"><path d="M2.5 6.2 5 8.6l4.5-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const host = document.createElement('div');
  host.id = HOST_ID;
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>${PANEL_CSS}</style>
    <div class="panel" id="panel" lang="${UI_LANG}">
      <div class="head">
        <svg class="logo" viewBox="0 0 24 24" aria-hidden="true">
          <path class="logo-shield" d="M12 1.6 20.4 4.6V11c0 5.4-3.5 9.6-8.4 11.4C7.1 20.6 3.6 16.4 3.6 11V4.6Z"/>
          <g class="logo-mark" transform="translate(7.2 7.4) scale(.226)">
            <path d="M12.5 0 0 8.1l8.7 7 12.5-7.8zM0 21.9l12.5 8.2 8.7-7.3-12.5-7.7zM21.2 22.8l8.8 7.3 12.4-8.1-8.6-6.9zM42.4 8.1 30 0l-8.8 7.3 12.6 7.8zM21.3 24.4l-8.8 7.3-3.7-2.5V32l12.5 7.5L33.8 32v-2.8L30 31.7z"/>
          </g>
        </svg>
        <div class="title">Dropbox Link Remover <span class="dot" title="${t('uiRunning')}"></span></div>
        <button class="icon-btn" id="min" title="${t('uiCollapse')}" aria-label="${t('uiCollapse')}">
          <svg viewBox="0 0 14 14" fill="none"><path d="M3.5 5.5 7 9l3.5-3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
      <div class="body">
        <div class="grid">
          <div class="label">${t('uiTargets')}</div>
          <div class="ctrl">
            <label class="chip"><input type="checkbox" id="kview" checked><span class="box">${CHECK_SVG}</span>${t('uiViewLinks')}</label>
            <label class="chip"><input type="checkbox" id="kedit" checked><span class="box">${CHECK_SVG}</span>${t('uiEditLinks')}</label>
          </div>

          <div class="label">${t('uiTest')}</div>
          <div class="ctrl">
            <button class="btn tint" id="diag"><span class="spinner"></span>${t('uiDiagnose')}</button>
            <button class="btn tint" id="one"><span class="spinner"></span>${t('uiDeleteOne')}</button>
          </div>

          <div class="label">${t('uiDeleteAll')}</div>
          <div class="ctrl">
            <button class="btn danger" id="start"><span class="spinner"></span>${t('uiStart')}</button>
            <button class="btn outline" id="stop">${t('uiStop')}</button>
          </div>
        </div>
        <div class="log-wrap">
          <div class="log" id="log"></div>
          <button class="icon-btn log-copy" id="copy" title="${t('uiCopyLog')}" aria-label="${t('uiCopyLog')}">${COPY_ICON}</button>
        </div>
        <div class="count" id="count"></div>
        <div class="note">
          <svg viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.3"/><path d="M8 4.8v3.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="11" r=".9" fill="currentColor"/></svg>
          <span>${t('uiNote')}</span>
        </div>
        <div class="alert" id="alert" role="alert" hidden>${t('uiStoppedByUser')}</div>
      </div>
    </div>
  `;

  const $ = (id) => root.getElementById(id);
  const logEl = $('log');
  let busyButton = null; // which button started the current run

  function log(msg, cls = '') {
    const line = document.createElement('div');
    if (cls) line.className = cls;
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = new Date().toLocaleTimeString([], { hour12: false });
    line.append(t, ' ' + msg);
    logEl.appendChild(line);
    while (logEl.childNodes.length > MAX_LOG_LINES) logEl.firstChild.remove();
    logEl.scrollTop = logEl.scrollHeight;
    console.log('[DLR]', msg);
  }

  function updateUI() {
    $('count').innerHTML = countText(deletedTotal, `<span class="count-num">${deletedTotal}</span>`);
    $('panel').classList.toggle('running', running);
    for (const id of ['start', 'one', 'diag']) {
      $(id).disabled = running;
      $(id).classList.toggle('busy', running && busyButton === id);
    }
    $('stop').disabled = !running;
  }

  function saveSettings() {
    if (contextValid()) chrome.storage.local.set({ [STORAGE_KEY]: { view: settings.view, edit: settings.edit } });
  }

  $('kview').addEventListener('change', (e) => { settings.view = e.target.checked; saveSettings(); });
  $('kedit').addEventListener('change', (e) => { settings.edit = e.target.checked; saveSettings(); });

  $('start').addEventListener('click', () => {
    const kinds = selectedKinds();
    if (!kinds) return log(L('logSelectTargets'), 'warn');
    if (!confirm(t('confirmDeleteAll', kinds))) return;
    busyButton = 'start';
    run();
  });
  $('one').addEventListener('click', () => {
    busyButton = 'one';
    run(1);
  });
  $('stop').addEventListener('click', () => {
    stopRequested = true;
    log(L('logStopping'));
  });
  $('diag').addEventListener('click', () => {
    busyButton = 'diag';
    diagnose();
  });
  let copyFeedbackTimer;
  $('copy').addEventListener('click', async () => {
    const text = [...logEl.childNodes].map((n) => n.textContent).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      log(L('logCopied'), 'muted');
      $('copy').innerHTML = COPIED_ICON;
      clearTimeout(copyFeedbackTimer);
      copyFeedbackTimer = setTimeout(() => ($('copy').innerHTML = COPY_ICON), COPY_FEEDBACK_MS);
    } catch {
      log(L('logCopyFailed'), 'warn');
    }
  });
  $('min').addEventListener('click', () => {
    const collapsed = $('panel').classList.toggle('collapsed');
    const label = collapsed ? t('uiExpand') : t('uiCollapse');
    $('min').title = label;
    $('min').setAttribute('aria-label', label);
  });

  chrome.storage.local.get(STORAGE_KEY, (stored) => {
    const saved = stored?.[STORAGE_KEY] || {};
    // Only the checkboxes are persisted; the delay always comes from DEFAULT_DELAY_MS
    if (typeof saved.view === 'boolean') settings.view = saved.view;
    if (typeof saved.edit === 'boolean') settings.edit = saved.edit;
    $('kview').checked = settings.view;
    $('kedit').checked = settings.edit;
  });

  // ---- Visibility (also follows in-app SPA navigation) ----
  let userHidden = false;
  const onLinksPage = () => LINKS_PATH_RE.test(location.pathname);

  function ensureFonts() {
    if (document.getElementById(FONTS_LINK_ID)) return;
    const link = document.createElement('link');
    link.id = FONTS_LINK_ID;
    link.rel = 'stylesheet';
    link.href = GOOGLE_FONTS_URL;
    (document.head || document.documentElement).appendChild(link);
  }

  // Stop any run and remove everything this script added to the page
  function teardown() {
    stopRequested = true;
    clearInterval(visibilityTimer);
    USER_ACTIVITY_EVENTS.forEach((type) => window.removeEventListener(type, onUserActivity, { capture: true }));
    host.remove();
    document.getElementById(FONTS_LINK_ID)?.remove();
    window.__dlrLoaded = false;
    console.info('[DLR] Extension was reloaded; reload the page to use the new version.');
  }

  function syncVisibility() {
    if (!contextValid()) return teardown();
    const show = onLinksPage() && !userHidden;
    if (show) ensureFonts();
    if (show && !host.isConnected) document.documentElement.appendChild(host);
    host.style.display = show ? '' : 'none';
    if (!onLinksPage() && running) stopRequested = true;
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== TOGGLE_MESSAGE) return;
    if (!onLinksPage()) {
      location.href = LINKS_URL;
      return;
    }
    userHidden = !userHidden;
    syncVisibility();
  });

  const visibilityTimer = setInterval(syncVisibility, VISIBILITY_CHECK_MS);
  syncVisibility();
  updateUI();
  if (onLinksPage()) log(L('logReady', t('uiDiagnose')), 'muted');
})();
