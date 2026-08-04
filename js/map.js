/**
 * Trail Recorder - 地图管理器
 * 使用 Leaflet + OpenStreetMap
 */

class MapManager {
  constructor() {
    this.map = null;
    this._locationMarker = null;
    this._accuracyCircle = null;
    this._trailLayer = null;
    this._lastTrailCount = 0;
    this._theme = 'dark';
    this._baseLayer = null;
  }

  init(containerId, center, zoom) {
    const mapEl = document.getElementById(containerId);
    if (!mapEl) {
      console.error('[MapManager] 地图容器不存在');
      throw new Error('地图容器不存在');
    }

    this.map = L.map(containerId, {
      center: [center.lat, center.lng],
      zoom: zoom || CONFIG.DEFAULT_ZOOM,
      zoomControl: false,
      attributionControl: false
    });

    this._baseLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      maxNativeZoom: 19
    }).addTo(this.map);

    L.control.zoom({ position: 'bottomright' }).addTo(this.map);

    this._trailLayer = L.layerGroup().addTo(this.map);

    this.map.on('click', (e) => {
      if (this.onMapClick) {
        this.onMapClick({ lat: e.latlng.lat, lng: e.latlng.lng });
      }
    });
  }

  set onMapClick(fn) {
    this._onMapClick = fn;
  }
  get onMapClick() {
    return this._onMapClick;
  }

  flyTo(center, zoom) {
    if (!this.map) return;
    this.map.flyTo([center.lat, center.lng], zoom || CONFIG.LOCATION_ZOOM, {
      duration: 0.5
    });
  }

  setLocation(center, accuracy, heading) {
    if (!this.map) return;
    const latLng = [center.lat, center.lng];

    if (this._locationMarker) {
      this._locationMarker.setLatLng(latLng);
      if (heading != null && !isNaN(heading)) {
        this._locationMarker.setIcon(this._createLocationIcon(heading));
      } else {
        this._locationMarker.setIcon(this._createLocationIcon());
      }
    } else {
      this._locationMarker = L.marker(latLng, {
        icon: this._createLocationIcon(heading),
        interactive: false
      }).addTo(this.map);
    }

    if (accuracy != null && !isNaN(accuracy) && accuracy > 0) {
      if (this._accuracyCircle) {
        this._accuracyCircle.setLatLng(latLng);
        this._accuracyCircle.setRadius(accuracy);
      } else {
        this._accuracyCircle = L.circle(latLng, {
          radius: accuracy,
          color: '#0088FF',
          fillColor: '#0088FF',
          fillOpacity: 0.08,
          weight: 1,
          opacity: 0.3
        }).addTo(this.map);
      }
    } else if (this._accuracyCircle) {
      this._accuracyCircle.remove();
      this._accuracyCircle = null;
    }
  }

  _createLocationIcon(heading) {
    const arrow = (heading != null && !isNaN(heading))
      ? `<polygon points="20,2 23,10 17,10" fill="#00A3FF" transform="rotate(${heading}, 20, 20)"/>`
      : '';
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">
        <circle cx="20" cy="20" r="17" fill="none" stroke="#0088FF" stroke-width="1.5" opacity="0.12"/>
        <circle cx="20" cy="20" r="13" fill="none" stroke="#0088FF" stroke-width="2" opacity="0.28"/>
        <circle cx="20" cy="20" r="7" fill="#0088FF" stroke="#fff" stroke-width="2.5"/>
        <circle cx="20" cy="20" r="2.5" fill="#fff" opacity="0.95"/>
        ${arrow}
      </svg>`;

    return L.divIcon({
      html: svg,
      className: 'location-marker',
      iconSize: [40, 40],
      iconAnchor: [20, 20]
    });
  }

  setTrail(positions, smooth) {
    if (!this.map || !this._trailLayer) return;
    if (!Array.isArray(positions) || positions.length < 2) {
      this.clearTrail();
      return;
    }

    if (positions.length < (this._lastTrailCount || 0)) {
      this.clearTrail();
    }

    const from = Math.max(1, this._lastTrailCount || 0);
    if (from >= positions.length) return;

    const posToUse = smooth ? positions : positions;

    let batchPath = [];
    let batchKey = null;

    if ((this._lastTrailCount || 0) > 0) {
      const anchor = posToUse[this._lastTrailCount - 1];
      batchPath.push([anchor.lat, anchor.lng]);
      batchKey = speedColorKey(this._segmentSpeed(anchor, posToUse[this._lastTrailCount]));
    }

    for (let i = from; i < posToUse.length; i++) {
      const p0 = posToUse[i - 1];
      const p1 = posToUse[i];
      const key = speedColorKey(this._segmentSpeed(p0, p1));

      if (batchPath.length === 0) {
        batchPath.push([p0.lat, p0.lng]);
        batchPath.push([p1.lat, p1.lng]);
        batchKey = key;
      } else if (key === batchKey) {
        batchPath.push([p1.lat, p1.lng]);
      } else {
        if (batchPath.length >= 2) {
          this._flushSegment(batchPath, batchKey);
        }
        batchPath = [[p0.lat, p0.lng], [p1.lat, p1.lng]];
        batchKey = key;
      }
    }
    if (batchPath.length >= 2) {
      this._flushSegment(batchPath, batchKey);
    }
    this._lastTrailCount = positions.length;
  }

  _segmentSpeed(p0, p1) {
    return p1.speed != null ? p1.speed : (p0.speed != null ? p0.speed : 0);
  }

  _flushSegment(path, speedKey) {
    const colors = getSpeedColors(this._theme);
    const clr = colors[speedKey] || colors.walk;
    const polyline = L.polyline(path, {
      color: `rgba(${clr.r}, ${clr.g}, ${clr.b}, ${clr.a})`,
      weight: 4,
      opacity: 0.9,
      lineCap: 'round',
      lineJoin: 'round'
    }).addTo(this._trailLayer);
  }

  clearTrail() {
    if (this._trailLayer) {
      this._trailLayer.clearLayers();
    }
    this._lastTrailCount = 0;
  }

  setTheme(theme) {
    this._theme = theme;
    const tileUrl = theme === 'light'
      ? 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
      : 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
    if (this._baseLayer) {
      this._baseLayer.setUrl(tileUrl);
    }
  }

  fitTrailBounds(positions) {
    if (!this.map || !Array.isArray(positions) || positions.length < 2) return;
    const bounds = [];
    for (const p of positions) {
      bounds.push([p.lat, p.lng]);
    }
    if (bounds.length > 0) {
      this.map.fitBounds(bounds, { padding: [50, 50] });
    }
  }

  destroy() {
    if (this.map) {
      this.map.remove();
      this.map = null;
    }
  }
}
