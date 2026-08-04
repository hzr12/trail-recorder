/**
 * Trail Recorder - UI 渲染模块
 * 负责所有 DOM 操作和事件绑定
 */

class TrailUI {
  constructor(app) {
    this.app = app;
    this._initialized = false;
  }

  async init() {
    if (this._initialized) return;

    // 绑定历史列表事件
    this._bindHistoryEvents();

    // 绑定面板拖拽
    this._bindPanelDrag();

    // 绑定统计弹窗
    this._bindStatsModal();

    this._initialized = true;
  }

  _bindHistoryEvents() {
    // 历史轨迹点击
    document.getElementById('history-list')?.addEventListener('click', (e) => {
      const item = e.target.closest('.history-item');
      if (item) {
        const id = item.dataset.id;
        if (id) {
          this.app._loadTrail(id);
        }
      }
    });
  }

  _bindPanelDrag() {
    const panel = document.getElementById('bottomPanel');
    const handle = document.querySelector('.panel-handle');
    if (!panel || !handle) return;

    let startY = 0;
    let startHeight = 0;

    handle.addEventListener('touchstart', (e) => {
      startY = e.touches[0].clientY;
      startHeight = panel.offsetHeight;
    }, { passive: true });

    handle.addEventListener('touchmove', (e) => {
      const deltaY = startY - e.touches[0].clientY;
      const newHeight = Math.max(200, Math.min(startHeight + deltaY, window.innerHeight * 0.8));
      panel.style.height = newHeight + 'px';
    }, { passive: true });
  }

  _bindStatsModal() {
    const modal = document.getElementById('stats-modal');
    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          this.app._hideStats();
        }
      });
    }
  }
}
