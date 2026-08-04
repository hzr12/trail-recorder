# Trail Recorder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone GPS trail recorder app with Tencent Map, multi-trail history, start/end annotations, stats, and export — for Web and Android.

**Architecture:** Copy core modules (Trail, GPS, Storage, Map) from circlemap-gnss, strip circle/room logic, build new UI layer on top. IndexedDB for multi-trail persistence. Capacitor for Android APK.

**Tech Stack:** ES6 Class, Tencent Map SDK v2, Chart.js 4, IndexedDB, Capacitor v8, Android Gradle

## Global Constraints

- Zero build tools — browser opens `index.html` directly
- Pure ES6 Class, zero framework
- Chinese comments + Chinese UI
- localStorage key prefix: `trailrecorder_*` (no conflict with circlemap)
- IndexedDB name: `trailrecorder_db`
- Tencent Map API key: `OB4BZ-D4W3U-B7VVO-4PJWW-6TKDJ-WPB77`
- CDN: Tencent Map SDK, Chart.js 4
- All CSS/JS references use `?t=YYYYMMDDvN` version stamps

---

### Task 1: Project Scaffold

**Files:**
- Create: `F:\project\trail-recorder\index.html`
- Create: `F:\project\trail-recorder\css\theme.css`
- Create: `F:\project\trail-recorder\css\base.css`
- Create: `F:\project\trail-recorder\css\map.css`
- Create: `F:\project\trail-recorder\css\trail.css`
- Create: `F:\project\trail-recorder\css\history.css`
- Create: `F:\project\trail-recorder\css\stats.css`
- Create: `F:\project\trail-recorder\css\responsive.css`

**Interfaces:**
- Produces: Complete HTML shell with all CSS linked
- All CSS files follow the project's version stamp convention `?t=20260804v1`

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p "F:\project\trail-recorder\css" "F:\project\trail-recorder\js" "F:\project\trail-recorder\native\web"
```

- [ ] **Step 2: Write index.html** — HTML shell with:
  - `#map` container + `#circle-canvas` + `#overlay-canvas` (map CSS uses these IDs)
  - Floating GPS FAB button (top-right)
  - Bottom panel with: recording status bar, trail controls (start/pause/clear/stats/export/smooth/power-saving), history section
  - Script loading order: `config.js → toast.js → storage.js → trail.js → gps.js → map.js → trail-app.js → trail-ui.js`
  - Tencent Map SDK + Chart.js CDN
  - All CSS links with `?t=20260804v1` version stamps
  - `data-theme="dark"` on `<html>`, `data-accent="cyan"` default

- [ ] **Step 3: Write css/theme.css** — Copy from circlemap-gnss/css/theme.css, identical content

- [ ] **Step 4: Write css/base.css** — Copy from circlemap-gnss/css/base.css, identical content

- [ ] **Step 5: Write css/map.css** — Copy from circlemap-gnss/css/map.css, identical content

- [ ] **Step 6: Write css/trail.css** — Copy from circlemap-gnss/css/trail.css, remove `.power-section` styles (not needed), keep all trail recording styles

- [ ] **Step 7: Write css/history.css** — New file for history list styles:
  - `.history-section` — collapsible section
  - `.history-list` — scrollable list
  - `.history-item` — each trail entry with name, distance, time
  - `.history-item.active` — currently loaded trail highlight
  - `.history-empty` — empty state
  - `.history-manage-btn` — manage button

- [ ] **Step 8: Write css/stats.css** — New file for stats modal:
  - `.modal-overlay` + `.modal-box` — semi-transparent overlay with centered box
  - `.stat-grid` — 3-column grid for stat cards
  - `.stat-card` — individual stat card with label + value
  - `.histogram-section` + `.histogram-body` — speed distribution chart area
  - `.modal-close` — close button

- [ ] **Step 9: Write css/responsive.css** — Mobile-first responsive:
  - `@media (max-width: 480px)` adjustments
  - Bottom panel full-width on mobile
  - Smaller fonts for mobile
  - Touch-friendly button sizes (min 44px)

- [ ] **Step 10: Verify HTML loads without console errors**

Open `index.html` in a browser and check:
- No 404 errors for CSS/JS files
- No JS syntax errors in console
- Map container renders with correct dimensions

- [ ] **Step 11: Commit scaffold**

```bash
cd F:\project\trail-recorder && git init && git add -A && git commit -m "feat: scaffold trail-recorder project"
```

---

### Task 2: Config + Toast Utilities

**Files:**
- Create: `F:\project\trail-recorder\js\config.js`
- Create: `F:\project\trail-recorder\js\toast.js`

**Interfaces:**
- `CONFIG` object with all trail-recorder-specific constants
- `Toast.show(message, duration)` — static toast method
- `Toast.showUndo(message, onUndo, duration)` — static undo toast method

- [ ] **Step 1: Write js/config.js** — Adapted from circlemap-gnss/js/config.js:
  - Keep: `MAP_KEY`, `DEFAULT_CENTER`, `DEFAULT_ZOOM`, `LOCATION_ZOOM`, `MIN_RADIUS`, `MAX_RADIUS`, `DEFAULT_RADIUS`, `CONCENTRIC_INTERVAL`, `MIN_DRAW_PX`
  - Keep: `GPS_TIMEOUT`, `GPS_WATCH_TIMEOUT`, `GPS_LOW_ACCURACY_TIMEOUT`, `GPS_TIMEOUT_MAX_FAILURES`, `GPS_RECOVERY_INTERVAL_MS`
  - Keep: `EARTH_RADIUS`, `STORAGE_KEY` (change to `trailrecorder_trails`)
  - Keep: `POSITION_STALE_MS`, `RELOCATE_INTERVAL_MS`
  - Keep: `STATUS_THROTTLE_MS`, `MAX_RECENT_FIXES`, `MIN_DISPLACEMENT_M`
  - Keep: `TRAIL_SAMPLE_MIN_DIST`, `TRAIL_JITTER_FACTOR`, `TRAIL_MAX_POINTS`
  - Keep: `GPS_ADAPTIVE_K`, `GPS_MIN_INTERVAL`, `GPS_MAX_INTERVAL`, `GPS_MOVE_THRESHOLD`
  - Keep: `TRAIL_STORAGE_ENGINE`, `DB_NAME`, `DB_VERSION`, `DB_STORE_TRAIL`, `DB_MAX_SIZE`, `LS_MAX_SIZE`
  - Keep: `DEBUG`, `MOBILE_BREAKPOINT`, `DEFAULT_TOAST_DURATION`, `TOAST_FADE_MS`
  - Remove: `INPUT_DEBOUNCE_MS`, `PARSE_DELAY_MS`, `LONGPRESS_THRESHOLD_MS`, `LOCATED_ANIM_MS`, `EDIT_HIGHLIGHT_MS`
  - Remove: `ZOOM_MAP`, `INPUT_DEBOUNCE_MS`, `PARSE_DELAY_MS`, `LONGPRESS_THRESHOLD_MS`, `LOCATED_ANIM_MS`, `EDIT_HIGHLIGHT_MS`
  - Remove: `ENABLE_PREDICTION`, circle-related constants
  - Add: `TRAIL_HISTORY_MAX = 50` (max stored trails)
  - Add: `TRAIL_EXPORT_MAX_PTS = 600` (max points for export chart)
  - Add: `HISTOGRAM_BINS` and `HISTOGRAM_LABELS` constants
  - Add: `TRAIL_STORAGE_KEY = 'trailrecorder_trails'`
  - Add: `TRAIL_DB_NAME = 'trailrecorder_db'`
  - Add: `TRAIL_DB_STORE = 'trails'`
  - Keep all utility functions: `calcDistance`, `calcBearing`, `bearingToDir`, `sliderToRadius`, `radiusToSlider`, `formatDistance`, `copyText`, `ddToDms`

- [ ] **Step 2: Write js/toast.js** — Copy from circlemap-gnss/js/toast.js, identical content

- [ ] **Step 3: Verify config loads** — Open index.html in browser, check `CONFIG` is accessible in console via `window.CONFIG`

- [ ] **Step 4: Commit**

```bash
cd F:\project\trail-recorder && git add js/config.js js/toast.js && git commit -m "feat: add config and toast utilities"
```

---

### Task 3: Trail Data Model

**Files:**
- Create: `F:\project\trail-recorder\js\trail.js`

**Interfaces:**
- `class Trail` with methods: `start()`, `stop()`, `pause()`, `resume()`, `clear()`, `addPoint(pt)`, `getDistance()`, `getPointCount()`, `getSmoothedPositions(windowSize)`, `getStartPoint()`, `getEndPoint()`, `setAnnotation(label, index)`, `toJSON()`, `fromJSON(json)`

- [ ] **Step 1: Write js/trail.js** — Adapted from circlemap-gnss/js/trail.js:
  - Copy all existing methods unchanged
  - Add `this.annotations = []` in constructor
  - Add `this.startPoint = null` in constructor
  - Add `this.endPoint = null` in constructor
  - Add `this.name = '未命名'` in constructor
  - In `start()`: set `this.startPoint = null` (will be set on first addPoint)
  - In `stop()`: set `this.endPoint = this.positions.length > 0 ? this.positions[this.positions.length - 1] : null`
  - In `clear()`: reset `this.startPoint = null`, `this.endPoint = null`, `this.annotations = []`, `this.name = '未命名'`
  - In `addPoint(pt)`: if first point and `this.startPoint === null`, set `this.startPoint = { ...pt }`
  - Add `getStartPoint()` — returns `this.startPoint`
  - Add `getEndPoint()` — returns `this.endPoint`
  - Add `setAnnotation(label, index)` — adds annotation at position index
  - Add `toJSON()` — serializes all fields including annotations
  - Add `static fromJSON(json)` — deserializes trail record
  - Remove `restore()` method (not needed for standalone)
  - Keep all existing sampling/distance/smoothing logic unchanged

- [ ] **Step 2: Verify Trail class works** — Open browser console, test:
  ```js
  const t = new Trail(); t.start(); t.addPoint({lat:23.129,lng:113.264,accuracy:5}); t.stop();
  console.log(t.getStartPoint(), t.getEndPoint(), t.getDistance())
  ```
  Expected: startPoint and endPoint are the same point, distance is 0

- [ ] **Step 3: Commit**

```bash
cd F:\project\trail-recorder && git add js/trail.js && git commit -m "feat: add Trail data model with start/end annotations"
```

---

### Task 4: GPS Manager

**Files:**
- Create: `F:\project\trail-recorder\js\gps.js`

**Interfaces:**
- `class KalmanFilter` — 2D constant-velocity model, identical to original
- `class GPSManager` — Geolocation watcher with adaptive interval, Kalman filter, power saving

- [ ] **Step 1: Write js/gps.js** — Copy from circlemap-gnss/js/gps.js with modifications:
  - Keep `KalmanFilter` class unchanged (1-220 lines)
  - Keep `GPSManager` class unchanged (221-1157 lines)
  - Remove `_gnssPlugin` / `_gnssSatellites` / `_gnssListeningStarted` / `startGnss()` / `stopGnss()` / `_startGnssImpl()` / `_removeGnssListeners()` / `_startGnssPollFallback()` / `_stopGnssPollFallback()` — GNSS native plugin not needed for standalone web app
  - Remove `_initBatteryMonitor()` / `_cleanupBatteryMonitor()` / `_batteryCheck` — battery monitoring not needed for standalone
  - Remove `_powerSavingLocked` / `_autoStoppedByBattery` / `onCriticalBattery` / `onRestoreTracking` — battery callbacks not needed
  - Keep: `_updateAdaptiveInterval()`, `togglePowerSaving()`, `isPowerSaving`, `currentInterval`, `lastActualInterval`, `toggleFilter()`, `isDowngraded`, `consecutiveTimeouts`, `startWatching()`, `stopWatching()`, `getCurrentPosition()`, `getLastPosition()`, `lastRawPosition`, `destroy()`
  - Remove `_tryInitGnssPlugin()` — no Capacitor dependency
  - Remove `_initBatteryMonitor()` from constructor — no battery monitoring
  - Remove `this._battery = null` etc. from constructor
  - Remove `this.onCriticalBattery = null` etc. from constructor
  - Keep `this._powerSaving` and `this.togglePowerSaving()` — still useful for web
  - Keep `this._gnssPlugin = null` but remove all GNSS-related logic
  - Simplify constructor to remove GNSS and battery fields

- [ ] **Step 2: Verify GPSManager loads** — Open browser console, test:
  ```js
  const gps = new GPSManager(); console.log('GPSManager created', typeof gps.startWatching)
  ```
  Expected: no errors, method exists

- [ ] **Step 3: Commit**

```bash
cd F:\project\trail-recorder && git add js/gps.js && git commit -m "feat: add GPS manager with Kalman filter"
```

---

### Task 5: Storage (Multi-Trail IndexedDB)

**Files:**
- Create: `F:\project\trail-recorder\js\storage.js`

**Interfaces:**
- `Storage.saveTrail(trail)` — saves single trail
- `Storage.loadTrail(id)` — loads specific trail by ID
- `Storage.loadAllTrails()` — loads all trails sorted by updatedAt desc
- `Storage.deleteTrail(id)` — deletes a trail
- `Storage.clearAllTrails()` — clears all trails
- `Storage.getTrailCount()` — returns number of stored trails

- [ ] **Step 1: Write js/storage.js** — New implementation, not copied from original:
  - Use IndexedDB as primary engine (no localStorage fallback needed for standalone)
  - DB name: `trailrecorder_db`, version 1
  - Store name: `trails`, keyPath: `id`
  - Index: `updatedAt` (non-unique, for sorting)
  - `saveTrail(trail)`:
    - Validate trail has positions or is recording
    - Store with `updatedAt: Date.now()`
    - Enforce `TRAIL_HISTORY_MAX` limit — delete oldest if exceeded
    - Handle QuotaExceededError by decimating oldest trails first
  - `loadTrail(id)`:
    - Returns Promise resolving to trail or null
    - Decodes CT1 binary format if needed
  - `loadAllTrails()`:
    - Returns Promise resolving to array of trail summaries (id, name, pointCount, distance, updatedAt)
    - Sorted by updatedAt descending
    - Limited to `TRAIL_HISTORY_MAX` entries
  - `deleteTrail(id)`:
    - Deletes from IndexedDB
    - Returns Promise
  - `clearAllTrails()`:
    - Clears entire store
    - Returns Promise
  - `getTrailCount()`:
    - Returns Promise resolving to count
  - No CT1 binary encoding needed — store positions as JSON arrays (simpler for multi-trail)
  - Add migration from old `circlemap_trail` localStorage key if present

- [ ] **Step 2: Verify Storage works** — Open browser console:
  ```js
  const t = new Trail(); t.start(); t.addPoint({lat:23.129,lng:113.264,accuracy:5}); t.stop();
  Storage.saveTrail(t).then(() => Storage.loadAllTrails()).then(console.log)
  ```
  Expected: array with one trail entry

- [ ] **Step 3: Commit**

```bash
cd F:\project\trail-recorder && git add js/storage.js && git commit -m "feat: add multi-trail IndexedDB storage"
```

---

### Task 6: Map Manager (Simplified)

**Files:**
- Create: `F:\project\trail-recorder\js\map.js`

**Interfaces:**
- `class MapManager` — Tencent Map + Canvas trail overlay
- Methods: `init(containerId, center, zoom)`, `setMyPos(pos)`, `setTrail(positions)`, `clearTrail()`, `setStartPoint(pos)`, `setEndPoint(pos)`, `flyTo(pos)`, `setLocation(pos, accuracy, heading)`, `getCenter()`, `setCenter(pos)`, `getMap()`

- [ ] **Step 1: Write js/map.js** — Adapted from circlemap-gnss/js/map.js:
  - Copy roundRect polyfill (lines 1-29) unchanged
  - Copy `MapManager` class constructor, keeping only trail-related fields:
    - Keep: `map`, `marker`, `canvas`, `ctx`, `overlayCanvas`, `overlayCtx`, `center`, `mode`, `onMapClick`, `locationMarker`, `accuracyCircle`, `trailPolylines`, `_lastTrailCount`, `_myPos`, `_theme`
    - Remove: `circles`, `selectedCircleId`, `_remoteCircles`, `_idCounter`, `PICK_THRESHOLD`, `_rafId`, `_overlayRafId`, `_syncCenter`, `_coordCache`, `targetCircle`, `_targetPos`, `playerMarkers`, `playerAccuracyCircles`, `_playerPredictions`, `onCenterChange`, `onLongPress`
  - `init(containerId, center, zoom)`:
    - Keep Tencent map init logic
    - Keep Canvas overlay init
    - Remove circle-related setup
  - `setTrail(positions)`:
    - Keep trail rendering logic (speed-colored polyline segments)
    - Remove circle rendering
  - `clearTrail()`:
    - Keep trail clearing logic
  - `setStartPoint(pos)`:
    - New method: add green marker on map at pos
  - `setEndPoint(pos)`:
    - New method: add red marker on map at pos
  - `setMyPos(pos)`:
    - Keep existing logic
  - `setLocation(pos, accuracy, heading)`:
    - Keep existing logic (accuracy circle + heading arrow)
  - `flyTo(pos)`:
    - Keep existing logic
  - Remove all circle-related methods: `addCircle`, `removeCircle`, `updateCircleRadius`, `getCircles`, `getSelectedCircle`, `selectCircle`, `setTarget`, `setTargetRange`, `clearTarget`
  - Remove `_renderCircles`, `_renderCircle`, `_renderTarget`, `_renderOverlay`, `_updateOverlay`, `_speedColorKey`, `_speedColorDark`, `_speedColorLight` — keep only trail rendering
  - Keep `_renderTrailRange`, `_renderRemainingTrail`, `_segmentSpeed`, `_speedColorKey` for trail coloring
  - Keep `refreshTrailColors`, `clearTrail` for trail updates
  - Remove `_scheduleRedraw`, `_scheduleRedrawOverlay` — simplify to just redraw on change

- [ ] **Step 2: Verify MapManager loads** — Open browser console:
  ```js
  const m = new MapManager(); console.log('MapManager created', typeof m.init)
  ```
  Expected: no errors, method exists

- [ ] **Step 3: Commit**

```bash
cd F:\project\trail-recorder && git add js/map.js && git commit -m "feat: add simplified MapManager for trail display"
```

---

### Task 7: App Main Class

**Files:**
- Create: `F:\project\trail-recorder\js\trail-app.js`

**Interfaces:**
- `class TrailApp` — main application controller
- Methods: `init()`, `_startWatching()`, `_stopWatching()`, `_toggleTrailRecording()`, `_toggleTrailPause()`, `_clearTrail()`, `_showTrailStats()`, `_exportReport()`, `_toggleTrailSmoothing()`, `_togglePowerSaving()`, `_updateTrailUI()`, `_updateTrailBar()`, `_updateStatusBar()`, `_updateHistoryList()`, `_loadTrail(id)`, `_deleteTrail(id)`, `_renameTrail(id, name)`, `_saveState()`, `_loadState()`, `_updatePowerStatus()`, `_processPosition(pos)`

- [ ] **Step 1: Write js/trail-app.js** — New file, standalone App class:
  - Constructor initializes: `mapManager`, `gpsManager`, `trail`, `trailUI`
  - `init()`:
    - Init map with default center and zoom
    - Setup UI event bindings
    - Load saved state from Storage
    - Start GPS watching
    - Start 60s auto-save interval
    - Restore theme/accent preferences
  - `_startWatching()`:
    - Start GPS with standard options
    - Set `onPositionChange` callback to add trail points
    - Show speed chart
  - `_stopWatching()`:
    - Stop GPS
    - Clear callbacks
    - Hide speed chart
  - `_toggleTrailRecording()`:
    - If recording: stop, save trail, record end point
    - If not recording: start new trail, clear map trail, set mode to trail
  - `_toggleTrailPause()`:
    - Toggle pause on current trail
  - `_clearTrail()`:
    - Clear current trail, clear map, update UI
    - Show undo toast
  - `_showTrailStats()`:
    - Calculate stats from current trail
    - Show modal with stats + histogram
  - `_exportReport()`:
    - Generate PNG with map canvas + speed chart + stats
    - Web: download; Android: share via Capacitor Share plugin
  - `_toggleTrailSmoothing()`:
    - Toggle smoothing preference
    - Refresh trail rendering
  - `_togglePowerSaving()`:
    - Toggle GPS power saving mode
  - `_updateTrailUI()`:
    - Update all trail control button states
    - Update distance/duration display
  - `_updateTrailBar()`:
    - Update floating status bar
  - `_updateHistoryList()`:
    - Load all trails from Storage
    - Render history list in bottom panel
  - `_loadTrail(id)`:
    - Load trail from Storage
    - Set as current trail
    - Render on map
  - `_deleteTrail(id)`:
    - Delete from Storage
    - Update history list
    - Show undo toast
  - `_renameTrail(id, name)`:
    - Update trail name in Storage
    - Refresh history list
  - `_processPosition(pos)`:
    - Add point to trail if recording
    - Update map trail
    - Update UI
  - `_saveState()`:
    - Save current trail to Storage if dirty
  - `_loadState()`:
    - Load last active trail from Storage
  - `_updatePowerStatus()`:
    - Update power status display
  - `_updateStatusBar()`:
    - Update GPS status display

- [ ] **Step 2: Verify TrailApp loads** — Open browser console:
  ```js
  const app = new TrailApp(); console.log('TrailApp created', typeof app.init)
  ```
  Expected: no errors, method exists

- [ ] **Step 3: Commit**

```bash
cd F:\project\trail-recorder && git add js/trail-app.js && git commit -m "feat: add TrailApp main controller"
```

---

### Task 8: UI Rendering Module

**Files:**
- Create: `F:\project\trail-recorder\js\trail-ui.js`

**Interfaces:**
- `TrailUI` class — all DOM rendering and event handling
- Methods for rendering: status bar, trail controls, history list, stats modal, power status, GPS status

- [ ] **Step 1: Write js/trail-ui.js** — New file:
  - `renderStatusBar(pos, isWatching, isRecording, isPaused, powerSaving)` — renders GPS status line
  - `renderTrailControls(trail, isRecording, isPaused)` — renders start/pause/clear/stats/export buttons
  - `renderHistoryList(trails, activeTrailId)` — renders scrollable history list
  - `renderStatsModal(trail)` — renders stats modal with histogram
  - `renderPowerStatus(interval, batteryLevel, isCharging)` — renders power/location interval display
  - `renderTrailBar(trail)` — renders floating status bar (recording dot, distance)
  - `renderMapMarkers(startPoint, endPoint)` — renders start/end markers on map
  - Event binding methods for all UI controls
  - Theme/accent toggle logic
  - Mobile panel collapse/expand logic

- [ ] **Step 2: Verify UI renders** — Open index.html in browser, check all UI elements appear correctly

- [ ] **Step 3: Commit**

```bash
cd F:\project\trail-recorder && git add js/trail-ui.js && git commit -m "feat: add TrailUI rendering module"
```

---

### Task 9: Android Capacitor Setup

**Files:**
- Create: `F:\project\trail-recorder\native\capacitor.config.json`
- Create: `F:\project\trail-recorder\native\package.json`
- Copy: `F:\project\trail-recorder\native\gnss-plugin\` from circlemap-gnss
- Create: `F:\project\trail-recorder\native\web\` (build output dir)

**Interfaces:**
- Capacitor config for Android APK build
- GNSS plugin for native satellite data
- Background geolocation for background tracking

- [ ] **Step 1: Create native/capacitor.config.json**

```json
{
  "appId": "com.trailrecorder.app",
  "appName": "TrailRecorder",
  "webDir": "web",
  "server": {
    "hostname": "localhost",
    "androidScheme": "https",
    "androidUseLegacyBridge": true
  },
  "plugins": {
    "GnssData": {},
    "Filesystem": {},
    "Share": {},
    "BackgroundGeolocation": {}
  }
}
```

- [ ] **Step 2: Create native/package.json**

```json
{
  "name": "trailrecorder-native",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "build:plugin": "cd gnss-plugin && npx tsc && cd ..",
    "sync": "npx cap sync",
    "build:apk": "cd android && ./gradlew assembleDebug"
  },
  "dependencies": {
    "@capacitor/android": "^8.0.0",
    "@capacitor/cli": "^8.0.0",
    "@capacitor/core": "^8.0.0",
    "@capacitor/filesystem": "^8.1.2",
    "@capacitor/share": "^8.0.1",
    "@capgo/background-geolocation": "^8.3.0",
    "gnss-data-plugin": "file:./gnss-plugin"
  },
  "devDependencies": {
    "typescript": "^5.5.0"
  }
}
```

- [ ] **Step 3: Copy gnss-plugin from circlemap-gnss**

```bash
cp -R "F:\project\circlemap-gnss\native\gnss-plugin" "F:\project\trail-recorder\native\"
```

- [ ] **Step 4: Create native/web directory and copy web assets**

```bash
mkdir -p "F:\project\trail-recorder\native\web"
# After web build, copy index.html + css/ + js/ to native/web/
```

- [ ] **Step 5: Verify native setup** — Run `npm install` in native directory (requires Node.js)

- [ ] **Step 6: Commit**

```bash
cd F:\project\trail-recorder && git add native/ && git commit -m "feat: add Capacitor Android native setup"
```

---

### Task 10: Integration & Polish

**Files:**
- Modify: `F:\project\trail-recorder\index.html` (script loading order, version stamps)
- Modify: `F:\project\trail-recorder\css\*.css` (any final adjustments)

**Interfaces:**
- All scripts load in correct order
- All CSS linked with correct version stamps
- App initializes correctly on page load

- [ ] **Step 1: Update index.html script loading order** — Ensure:
  1. `js/config.js?t=20260804v1`
  2. `js/toast.js?t=20260804v1`
  3. `js/storage.js?t=20260804v1`
  4. `js/trail.js?t=20260804v1`
  5. `js/gps.js?t=20260804v1`
  6. `js/map.js?t=20260804v1`
  7. Tencent Map SDK (CDN)
  8. Chart.js CDN
  9. `js/trail-app.js?t=20260804v1`
  10. `js/trail-ui.js?t=20260804v1`

- [ ] **Step 2: Update version stamps** — Bump all `?t=` values to `20260804v1`

- [ ] **Step 3: Full integration test** — Open index.html in browser:
  - Map loads with Tencent tiles
  - GPS button shows correct state
  - Start recording → trace appears on map
  - Pause → trace stops updating
  - Stop → trail saved to history
  - History list shows recorded trail
  - Stats modal shows correct data
  - Export generates PNG
  - Theme toggle works
  - Accent color switcher works

- [ ] **Step 4: Commit**

```bash
cd F:\project\trail-recorder && git add -A && git commit -m "feat: integrate all modules and polish"
```

---

### Task 11: Final Verification

**Files:** None (verification only)

- [ ] **Step 1: Run all manual tests** — Verify each feature works:
  - GPS tracking starts/stops correctly
  - Trail points are recorded with correct sampling
  - Start/end points are marked on map
  - History list persists across page reloads
  - Trail deletion with undo works
  - Stats histogram renders correctly
  - Report export generates valid PNG
  - Power saving mode reduces GPS interval
  - Theme switching works
  - Mobile layout is correct

- [ ] **Step 2: Check for console errors** — Open browser dev tools, verify no errors

- [ ] **Step 3: Verify IndexedDB storage** — Open DevTools → Application → IndexedDB, verify trails are stored correctly

- [ ] **Step 4: Final commit**

```bash
cd F:\project\trail-recorder && git add -A && git commit -m "feat: trail recorder app complete"
```

---

## Execution Order

1. Task 1: Project Scaffold (HTML + CSS)
2. Task 2: Config + Toast
3. Task 3: Trail Data Model
4. Task 4: GPS Manager
5. Task 5: Storage
6. Task 6: Map Manager
7. Task 7: App Main Class
8. Task 8: UI Rendering
9. Task 9: Android Capacitor Setup
10. Task 10: Integration & Polish
11. Task 11: Final Verification

Each task builds on the previous one. No task can be completed without its dependencies.
