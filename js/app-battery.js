/**
 * 途刻 TraceCraft - 电池状态模块
 * =============================================
 * 通过 App.prototype.* 挂载到 App（须在 app-core.js 之后加载）：
 *  - _initBattery: 监听 Battery API（电量/充电/放电时间）
 *  - _cleanupBattery: 移除监听器（destroy 时调用）
 */

App.prototype._initBattery = function () {
  if (!navigator.getBattery) return;
  navigator.getBattery().then(battery => {
    this._battery = battery;
    this._batteryLevel = battery.level;
    this._batteryCharging = battery.charging;
    this._batteryTime = battery.dischargingTime;
    this._updateStatusBar(true);

    this._batteryLevelHandler = () => {
      this._batteryLevel = battery.level;
      this._batteryCharging = battery.charging;
      this._batteryTime = battery.dischargingTime;
      this._updateStatusBar(true);
      // 仅在首次进入低电量（≤15% 且未充电）时提示一次，避免每次 levelchange 重复弹
      if (battery.level <= 0.15 && !battery.charging) {
        if (!this._lowBatteryNotified) {
          this._lowBatteryNotified = true;
          Toast.show('电量不足 15%，建议开启省电模式');
        }
      } else {
        this._lowBatteryNotified = false;
      }
    };
    battery.addEventListener('levelchange', this._batteryLevelHandler);

    this._batteryChargingHandler = () => {
      this._batteryCharging = battery.charging;
      this._batteryTime = battery.dischargingTime;
      this._updateStatusBar(true);
    };
    battery.addEventListener('chargingchange', this._batteryChargingHandler);

    this._batteryTimeHandler = () => {
      this._batteryTime = battery.dischargingTime;
      this._updateStatusBar(true);
    };
    battery.addEventListener('dischargingtimechange', this._batteryTimeHandler);
  }).catch(() => {});
};

App.prototype._cleanupBattery = function () {
  if (this._battery) {
    if (this._batteryLevelHandler) this._battery.removeEventListener('levelchange', this._batteryLevelHandler);
    if (this._batteryChargingHandler) this._battery.removeEventListener('chargingchange', this._batteryChargingHandler);
    if (this._batteryTimeHandler) this._battery.removeEventListener('dischargingtimechange', this._batteryTimeHandler);
    this._battery = null;
    this._batteryLevelHandler = null;
    this._batteryChargingHandler = null;
    this._batteryTimeHandler = null;
  }
};
