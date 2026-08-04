/**
 * Trail Recorder - 地图管理器
 * 使用腾讯地图 SDK
 */

class MapManager {
  constructor() {
    this.map = null;
    this._locationMarker = null;
    this._accuracyCircle = null;
    this._trailLayer = null;
    this._startMarker = null;
    this._endMarker = null;
    this._lastTrailCount = 0;
    this._theme = 'dark';
    this.onMapClick = null;
  }

  init(containerId, center, zoom) {
    const mapEl = document.getElementById(containerId);
    if (!mapEl) {
      console.error('[MapManager] 地图容器不存在');
      throw new Error('地图容器不存在');
    }

    this.map = new qq.maps.Map(mapEl, {
      center: new qq.maps.LatLng(center.lat, center.lng),
      zoom: zoom || CONFIG.DEFAULT_ZOOM,
      zoomControl: false,
      scaleControl: true,
      overviewMapControl: false
    });

    // 绑定点击事件
    qq.maps.event.addListener(this.map, 'click', (e) => {
      if (this.onMapClick) {
        this.onMapClick({ lat: e.latLng.getLat(), lng: e.latLng.getLng() });
      }
    });

    // 绑定拖动事件
    qq.maps.event.addListener(this.map, 'center_changed', () => {
      this._syncCenter();
    });
  }

  _syncCenter() {
    // 可以在这里同步中心点
  }

  flyTo(center, zoom) {
    if (!this.map) return;
    this.map.setCenter(new qq.maps.LatLng(center.lat, center.lng));
    this.map.setZoom(zoom || CONFIG.LOCATION_ZOOM);
  }

  setLocation(center, accuracy, heading) {
    if (!this.map) return;

    const latLng = new qq.maps.LatLng(center.lat, center.lng);

    // 位置标记
    if (this._locationMarker) {
      this._locationMarker.setPosition(latLng);
    } else {
      const icon = this._createLocationIcon(heading);
      this._locationMarker = new qq.maps.Marker({
        position: latLng,
        map: this.map,
        icon: icon
      });
    }

    // 精度圈
    if (accuracy > 0) {
      if (this._accuracyCircle) {
        this._accuracyCircle.setCenter(latLng);
        this._accuracyCircle.setRadius(accuracy);
      } else {
        this._accuracyCircle = new qq.maps.Circle({
          center: latLng,
          radius: accuracy,
          map: this.map,
          strokeColor: '#0088FF',
          strokeWeight: 1,
          strokeOpacity: 0.3,
          fillColor: '#0088FF',
          fillOpacity: 0.08
        });
      }
    } else if (this._accuracyCircle) {
      this._accuracyCircle.setMap(null);
      this._accuracyCircle = null;
    }
  }

  _createLocationIcon(heading) {
    // 使用腾讯地图默认的蓝色标记
    return new qq.maps.MarkerImage(
      'data:image/svg+xml;base64,' + btoa(`
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">
          <circle cx="20" cy="20" r="17" fill="none" stroke="#0088FF" stroke-width="1.5" opacity="0.12"/>
          <circle cx="20" cy="20" r="13" fill="none" stroke="#0088FF" stroke-width="2" opacity="0.28"/>
          <circle cx="20" cy="20" r="7" fill="#0088FF" stroke="#fff" stroke-width="2.5"/>
          <circle cx="20" cy="20" r="2.5" fill="#fff" opacity="0.95"/>
          ${heading != null && !isNaN(heading) ? `<polygon points="20,2 23,10 17,10" fill="#00A3FF" transform="rotate(${heading}, 20, 20)"/>` : ''}
        </svg>
      `),
      new qq.maps.Size(40, 40),
      new qq.maps.Point(20, 20),
      new qq.maps.Size(40, 40)
    );
  }

  setTrail(positions, smooth) {
    if (!this.map || !positions || positions.length < 2) {
      this.clearTrail();
      return;
    }

    // 清除旧轨迹
    this.clearTrail();

    const posToUse = smooth ? this._getSmoothedPositions(positions) : positions;

    // 按速度分段绘制
    const segments = this._splitBySpeed(posToUse);

    for (const seg of segments) {
      this._drawSegment(seg.positions, seg.speedKey);
    }

    this._lastTrailCount = positions.length;
  }

  _getSmoothedPositions(positions, windowSize = 5) {
    const n = positions.length;
    if (n < 4) return positions;
    const half = Math.floor(windowSize / 2);
    const result = [];
    for (let i = 0; i < n; i++) {
      const start = Math.max(0, i - half);
      const end = Math.min(n - 1, i + half);
      let sumLat = 0, sumLng = 0;
      for (let j = start; j <= end; j++) {
        sumLat += positions[j].lat;
        sumLng += positions[j].lng;
      }
      const count = end - start + 1;
      result.push({
        lat: sumLat / count,
        lng: sumLng / count,
        speed: positions[i].speed,
        _smoothed: true
      });
    }
    return result;
  }

  _splitBySpeed(positions) {
    const segments = [];
    let currentSeg = { positions: [positions[0]], speedKey: speedColorKey(positions[0].speed) };

    for (let i = 1; i < positions.length; i++) {
      const key = speedColorKey(positions[i].speed);
      if (key === currentSeg.speedKey) {
        currentSeg.positions.push(positions[i]);
      } else {
        segments.push(currentSeg);
        currentSeg = { positions: [positions[i]], speedKey: key };
      }
    }
    if (currentSeg.positions.length > 0) {
      segments.push(currentSeg);
    }
    return segments;
  }

  _drawSegment(positions, speedKey) {
    const colors = getSpeedColors(this._theme);
    const clr = colors[speedKey] || colors.walk;

    const path = positions.map(p => new qq.maps.LatLng(p.lat, p.lng));

    const polyline = new qq.maps.Polyline({
      path: path,
      strokeColor: `rgba(${clr.r}, ${clr.g}, ${clr.b}, ${clr.a})`,
      strokeWeight: 4,
      strokeOpacity: 0.9,
      map: this.map
    });

    if (!this._trailLayer) {
      this._trailLayer = [];
    }
    this._trailLayer.push(polyline);
  }

  clearTrail() {
    if (this._trailLayer) {
      for (const item of this._trailLayer) {
        item.setMap(null);
      }
      this._trailLayer = [];
    }
    this._lastTrailCount = 0;
  }

  setStartPoint(pos) {
    if (!this.map || !pos) return;

    if (this._startMarker) {
      this._startMarker.setPosition(new qq.maps.LatLng(pos.lat, pos.lng));
    } else {
      this._startMarker = new qq.maps.Marker({
        position: new qq.maps.LatLng(pos.lat, pos.lng),
        map: this.map,
        icon: this._createPointIcon('#22c55e', '起点'),
        title: '起点'
      });
    }
  }

  setEndPoint(pos) {
    if (!this.map || !pos) return;

    if (this._endMarker) {
      this._endMarker.setPosition(new qq.maps.LatLng(pos.lat, pos.lng));
    } else {
      this._endMarker = new qq.maps.Marker({
        position: new qq.maps.LatLng(pos.lat, pos.lng),
        map: this.map,
        icon: this._createPointIcon('#ef4444', '终点'),
        title: '终点'
      });
    }
  }

  _createPointIcon(color, label) {
    // 创建带标签的标记
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 40">
        <circle cx="15" cy="15" r="12" fill="${color}" stroke="#fff" stroke-width="2"/>
        <text x="15" y="35" text-anchor="middle" fill="${color}" font-size="10" font-weight="bold">${label}</text>
      </svg>`;
    return new qq.maps.MarkerImage(
      'data:image/svg+xml;base64,' + btoa(svg),
      new qq.maps.Size(30, 40),
      new qq.maps.Point(15, 40),
      new qq.maps.Size(30, 40)
    );
  }

  setTheme(theme) {
    this._theme = theme;
    // 腾讯地图不支持动态切换底图，但可以重新设置
    if (this.map) {
      const center = this.map.getCenter();
      this.map.setMapTypeId(
        theme === 'light' ? qq.maps.MapTypeId.ROADMAP : qq.maps.MapTypeId.HYBRID
      );
      this.map.setCenter(center);
    }
  }

  fitTrailBounds(positions) {
    if (!this.map || !positions || positions.length < 2) return;

    let minLat = Infinity, maxLat = -Infinity;
    let minLng = Infinity, maxLng = -Infinity;

    for (const p of positions) {
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lng < minLng) minLng = p.lng;
      if (p.lng > maxLng) maxLng = p.lng;
    }

    const bounds = new qq.maps.LatLngBounds(
      new qq.maps.LatLng(minLat, minLng),
      new qq.maps.LatLng(maxLat, maxLng)
    );
    this.map.fitBounds(bounds, 50);
  }

  getMap() {
    return this.map;
  }

  destroy() {
    if (this.map) {
      // 腾讯地图不需要手动销毁
      this.map = null;
    }
    this._trailLayer = null;
    this._startMarker = null;
    this._endMarker = null;
    this._locationMarker = null;
    this._accuracyCircle = null;
  }
}
