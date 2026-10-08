// ホーム画面に追加して、アプリのように使うための準備(サービスワーカーの登録と、追加の案内)
(function () {
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function () { /* 登録できなくても、通常のページとして使える */ });
    });
  }

  var standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  var deferred = null;

  function show(id, on) { var el = document.getElementById(id); if (el) el.hidden = !on; }

  // Android(Chrome など): 「アプリをインストール」の案内を、ボタンから出す
  window.addEventListener('beforeinstallprompt', function (ev) {
    ev.preventDefault();
    deferred = ev;
    if (!standalone) show('installBox', true);
  });
  window.addEventListener('appinstalled', function () { deferred = null; show('installBox', false); });

  document.addEventListener('DOMContentLoaded', function () {
    // 管理画面のタブ: 選択中のタブが見える位置までスクロールする
    var nav = document.querySelector('.admin-subnav');
    var active = nav && nav.querySelector('a.active');
    if (active) nav.scrollLeft = active.offsetLeft - (nav.clientWidth - active.offsetWidth) / 2;

    var btn = document.getElementById('installBtn');
    if (btn) {
      btn.addEventListener('click', function () {
        if (!deferred) return;
        deferred.prompt();
        deferred.userChoice.finally(function () { deferred = null; show('installBox', false); });
      });
    }
    // iPhone・iPad(Safari): ボタンで追加できないので、手順を案内する
    var ua = navigator.userAgent || '';
    var isIos = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    var isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
    if (isIos && !standalone) show('iosHint', true);
    if (isIos && !isSafari && !standalone) { var h = document.getElementById('iosHint'); if (h) h.dataset.browser = 'other'; }
  });
})();
