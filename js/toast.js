/**
 * Toast 提示
 * =============================================
 * 消息提示 + 可撤销操作提示
 */

class Toast {
  /**
   * 显示短暂提示
   * @param {string} message
   * @param {number} [duration=3000] 显示时长（毫秒）
   */
  static show(message, duration) {
    const existing = document.querySelector('.toast-msg');
    if (existing) {
      clearTimeout(existing._removalTimer);
      existing.remove();
    }

    const toast = document.createElement('div');
    toast.className = 'toast-msg';
    toast.textContent = message;
    document.body.appendChild(toast);

    requestAnimationFrame(() => {
      toast.classList.add('show');
    });

    // 显式传 0（不自动关闭）必须生效，仅 null/undefined 回退默认值
    const ms = duration ?? CONFIG.DEFAULT_TOAST_DURATION;
    if (ms > 0) {
      toast._removalTimer = setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), CONFIG.TOAST_FADE_MS);
      }, ms);
    }
  }

  /**
   * 显示可撤销操作的 toast
   * @param {string} message 操作提示
   * @param {Function} onUndo 撤销回调
   * @param {number} [duration=5000] 超时自动关闭（毫秒）
   */
  static showUndo(message, onUndo, duration) {
    const existing = document.querySelector('.toast-msg');
    if (existing) {
      clearTimeout(existing._removalTimer);
      existing.remove();
    }

    // toast.js 先于 app-core.js 加载，不能依赖 App._escapeHtml，此处内联转义
    const safe = String(message).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));

    const toast = document.createElement('div');
    toast.className = 'toast-msg toast-action';
    toast.innerHTML = `<span>${safe}</span><button class="toast-undo-btn">撤销</button>`;
    document.body.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add('show'));

    const undoBtn = toast.querySelector('.toast-undo-btn');
    undoBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      clearTimeout(toast._removalTimer);
      undoBtn.disabled = true;
      undoBtn.textContent = '处理中...';
      try {
        const result = onUndo();
        if (result && typeof result.then === 'function') {
          await result;
        }
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), CONFIG.TOAST_FADE_MS);
      } catch (_) {
        Toast.show('撤销失败');
        undoBtn.disabled = false;
        undoBtn.textContent = '撤销';
      }
    });

    const ms = duration ?? 5000;
    // 显式传 0 表示不自动关闭
    if (ms > 0) {
      const autoTimer = setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), CONFIG.TOAST_FADE_MS);
      }, ms);
      toast._removalTimer = autoTimer;
    }
  }
}
