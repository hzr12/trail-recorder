/**
 * Trail Recorder - Toast 提示
 */

class Toast {
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

    const ms = duration || CONFIG.DEFAULT_TOAST_DURATION;
    toast._removalTimer = setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), CONFIG.TOAST_FADE_MS);
    }, ms);
  }
}
