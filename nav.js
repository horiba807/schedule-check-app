/**
 * スマホ用ボトムバーの画面切り替え
 * 画面（HTML）は1枚のまま、data-view を持つ3つのパネルのうち1つだけを表示します。
 * 表示・非表示の見た目は material.css（幅760px以下）で決めています。
 */
(function () {
  const VIEW_KEY = 'lectureCheckerActiveView';
  const views = Array.from(document.querySelectorAll('[data-view]'));
  const buttons = Array.from(document.querySelectorAll('.bottom-nav [data-target]'));
  if (views.length === 0 || buttons.length === 0) return;

  const names = views.map(v => v.dataset.view);

  function showView(name, scrollToTop) {
    if (!names.includes(name)) name = names[0];
    views.forEach(v => v.classList.toggle('is-active', v.dataset.view === name));
    buttons.forEach(b => {
      const active = b.dataset.target === name;
      b.classList.toggle('is-active', active);
      if (active) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    try { sessionStorage.setItem(VIEW_KEY, name); } catch (error) { /* 保存できなくても動作に影響なし */ }
    if (scrollToTop) window.scrollTo(0, 0);
  }

  buttons.forEach(b => b.addEventListener('click', () => showView(b.dataset.target, true)));

  let initial = names[0];
  try { initial = sessionStorage.getItem(VIEW_KEY) || initial; } catch (error) { /* 既定の画面を使う */ }
  showView(initial, false);

  // 他のスクリプトから画面を切り替えたいとき用（例：window.showView('calendar')）
  window.showView = name => showView(name, true);
})();
