/**
 * 途刻 TraceCraft - 天气模块
 * =============================================
 * 通过 App.prototype.* 挂载到 App（须在 app-core.js 之后加载）：
 *  - _fetchWeather: 统一入口（节流 + 位置去重）
 *  - _fetchWeatherOpenMeteo: 主天气源
 *  - _fetchWeatherWttrIn: 备用天气源（降级）
 *  - _weatherCat / _weatherCodeToZh: 静态编码映射
 */

// 天气描述 → 类型分类（用于天气胶囊动态上色）
// 优先级：晴 > 雪/冰雹 > 雨 > 云/阴/雾
App._weatherCat = function (desc) {
  if (!desc) return 'unknown';
  if (/晴/.test(desc)) return 'clear';
  if (/雪|冰雹/.test(desc)) return 'snow';
  if (/雨|阵雨/.test(desc)) return 'rain';
  if (/云|阴|雾|霰/.test(desc)) return 'cloudy';
  return 'unknown';
};

App._weatherCodeToZh = function (code) {
  const map = {
    0: '晴', 1: '大部晴', 2: '多云', 3: '阴',
    45: '雾', 48: '雾凇',
    51: '小毛毛雨', 53: '毛毛雨', 55: '大毛毛雨',
    61: '小雨', 63: '中雨', 65: '大雨',
    71: '小雪', 73: '中雪', 75: '大雪',
    80: '小阵雨', 81: '阵雨', 82: '大阵雨',
    95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '大雷阵雨伴冰雹'
  };
  return map[code] || '';
};

App.prototype._fetchWeather = function () {
  if (!navigator.onLine) return;
  if (this.gpsManager.isPowerSaving) return;
  const now = Date.now();
  if (this._lastWeatherFetch && now - this._lastWeatherFetch < 300000) return;
  if (this._lastWeatherPos && this.myPosition) {
    const d = calcDistance(this.myPosition, this._lastWeatherPos);
    if (d < 1000 && now - this._lastWeatherFetch < 1800000) return;
  }
  this._lastWeatherFetch = now;
  this._lastWeatherPos = this.myPosition ? { lat: this.myPosition.lat, lng: this.myPosition.lng } : this._lastWeatherPos;
  const pos = this.myPosition;
  const lat = pos?.lat ?? 39.9;
  const lng = pos?.lng ?? 116.4;
  // 主源 Open-Meteo，失败自动降级 wttr.in
  this._fetchWeatherOpenMeteo(lat, lng)
    .catch(() => this._fetchWeatherWttrIn(lat, lng).catch(() => {}));
};

App.prototype._fetchWeatherOpenMeteo = function (lat, lng) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,relative_humidity_2m,apparent_temperature,wind_speed_10m,weather_code&daily=sunrise,sunset&timezone=auto&forecast_days=1`;
  return fetch(url, { signal: AbortSignal.timeout(5000) })
    .then(r => r.json())
    .then(data => {
      const cur = data.current;
      if (!cur) throw new Error('no data');
      const temp = cur.temperature_2m;
      const feelsLike = cur.apparent_temperature;
      const humidity = cur.relative_humidity_2m;
      const desc = App._weatherCodeToZh(cur.weather_code);
      const feelsText = feelsLike != null ? ` 体感${Math.round(feelsLike)}°` : '';
      const humidityText = humidity != null ? ` 湿度${humidity}%` : '';
      let sunText = '';
      const daily = data.daily;
      if (daily?.sunrise?.[0] && daily?.sunset?.[0]) {
        const sunrise = daily.sunrise[0].slice(11);
        const sunset = daily.sunset[0].slice(11);
        sunText = ` 日出${sunrise} 日落${sunset}`;
      }
      // 更新时间：Open-Meteo current.time 为本地时区 ISO 时间（timezone=auto），取 HH:MM；缺失则用本地时间兜底，保证常驻
      let updateText;
      if (cur.time && /T\d{2}:\d{2}/.test(cur.time)) {
        updateText = cur.time.slice(11, 16);
      } else {
        const d = new Date();
        updateText = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      }
      // 日出日落等完整信息移入 title 悬停，常态只显示关键信息；更新时间独立胶囊醒目常驻
      const weatherTitle = `${temp}°C${feelsText}${humidityText}${desc ? ' ' + desc : ''}${sunText}`;
      this._weatherHtml =
        `<span class="gps-weather" data-w="${App._weatherCat(desc)}" title="${weatherTitle}">${temp}°C${feelsText}${humidityText}${desc ? ' ' + desc : ''}<span class="upd">· 更新${updateText}</span></span>`;
      this._updateStatusBar(true);
    });
};

/**
 * 备用天气源：wttr.in（Open-Meteo 失败时降级）
 * 返回结构：current_condition[0]（temp_C/FeelsLikeC/humidity/windspeedKmph/weatherDesc[0].value/localObsDateTime）
 * 与 weather[0].astronomy[0]（sunrise/sunset）。lang=zh 使 weatherDesc 直接返回中文。
 */
App.prototype._fetchWeatherWttrIn = function (lat, lng) {
  const url = `https://wttr.in/${lat.toFixed(4)},${lng.toFixed(4)}?format=j1&lang=zh&timezone=auto`;
  return fetch(url, { signal: AbortSignal.timeout(6000) })
    .then(r => r.json())
    .then(data => {
      const cc = data?.current_condition?.[0];
      if (!cc) throw new Error('no data');
      const temp = cc.temp_C;
      const feelsLike = cc.FeelsLikeC;
      const humidity = cc.humidity;
      const desc = cc.weatherDesc?.[0]?.value || '';
      const feelsText = feelsLike != null ? ` 体感${Math.round(feelsLike)}°` : '';
      const humidityText = humidity != null ? ` 湿度${humidity}%` : '';
      let sunText = '';
      const astro = data.weather?.[0]?.astronomy?.[0];
      if (astro?.sunrise && astro?.sunset) {
        sunText = ` 日出${astro.sunrise} 日落${astro.sunset}`;
      }
      // 更新时间：wttr.in localObsDateTime 如 "2026-08-07 02:30 PM"，转 24 小时制 HH:MM；缺失则用本地时间兜底，保证常驻
      let updateText = '';
      const obs = String(cc.localObsDateTime || '');
      const m = obs.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
      if (m) {
        let h = parseInt(m[1], 10) % 12;
        if (/pm/i.test(m[3])) h += 12;
        updateText = `${String(h).padStart(2, '0')}:${m[2]}`;
      } else {
        const d = new Date();
        updateText = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      }
      // 日出日落等完整信息移入 title 悬停，常态只显示关键信息；更新时间独立胶囊醒目常驻
      const weatherTitle = `${temp}°C${feelsText}${humidityText}${desc ? ' ' + desc : ''}${sunText}`;
      this._weatherHtml =
        `<span class="gps-weather" data-w="${App._weatherCat(desc)}" title="${weatherTitle}">${temp}°C${feelsText}${humidityText}${desc ? ' ' + desc : ''}<span class="upd">· 更新${updateText}</span></span>`;
      this._updateStatusBar(true);
    });
};
