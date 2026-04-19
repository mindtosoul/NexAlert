# MaheMobility: Comprehensive Project Report

## 1. Executive Summary

**MaheMobility** is a highly scalable, enterprise-grade Next-Gen Wrong-Way Driver Detection & V2X (Vehicle-to-Everything) Alert System. The core directive of the project is "Zero Hardcoding. Pure Logical Code." It achieves this by dynamically querying OpenStreetMap (OSM) data, running real-time map matching, and computing anomalies purely through geospatial logic. 

The system bridges a simulated environment (or CSV replay telemetry) with real-world ML-based anomaly detection and physical hardware alerts. It consists of four major pillars:
1. **Backend Engine**: A Node.js/Express/TypeScript server that orchestrates telemetry ingestion, real-time map matching, anomaly detection, ML inference, and traffic simulation.
2. **Frontend Command Center**: A React/Vite dashboard leveraging MapLibre GL for live traffic visualization, hazard corridors, feeder warnings, and system control.
3. **V2X Edge Node (Hardware)**: An ESP32-based physical dashboard with an OLED screen and buzzer, receiving sub-100ms alerts directly from the backend via WebSockets.
4. **Machine Learning Pipeline**: A Kaggle-trained Random Forest classifier that digests vehicle kinematics and GNSS quality features to output robust anomaly confidence scores.

---

## 2. System Architecture & Data Flow

The project is structured as a monorepo containing `backend/`, `frontend/`, `hardware/`, and `Kaggle/` components. 

### Data Flow
1. **Data Sources**: Telemetry is generated either by the built-in simulator (`trafficGenerator.ts`) or via historical CSV replay. Both streams feed into the ingestion layer via WebSockets (`TELEMETRY` or `TELEMETRY_BATCH`).
2. **Geospatial Matching**: The `detectionEngine.ts` maps incoming coordinates to the nearest OSM road segment (fetched dynamically via Overpass API in `osmService.ts`).
3. **Anomaly Detection**: 
   - Kinematic rules evaluate bearing deltas against road direction (factoring in `oneway` tags).
   - Anomaly streaks are tracked.
   - ML model (`gnssModel.ts`) evaluates the feature vector.
   - Swarm consensus checks nearby vehicles for mutual confirmations.
4. **Hazard Generation**: If an anomaly reaches critical confidence (100%), the system generates a "Danger Cone" (Turf polygon) and upgrades the vehicle state to `DANGER`.
5. **Broadcasting**: The backend broadcasts enriched telemetry, alerts, and hazard states to the Frontend Command Center and the ESP32 Hardware node.

---

## 3. Backend Engine (Node.js & TypeScript)

The backend is the brain of MaheMobility, built with Express, WebSockets (`ws`), and `@turf/turf` for spatial math.

### 3.1. API & WebSocket Server (`server.ts`)
- **WebSocket Ingestion**: Listens for telemetry payloads, handles batching, and manages client connections (React UI, Simulator, ESP32).
- **REST Endpoints**: Controls simulation state (`/start-simulation`, `/set-simulation-mode`), injects intruders (`/inject-intruder`), handles OSM area scanning (`/update-region`), manages construction overrides, and controls CSV replays.
- **ML Training Pipeline**: Serves the `GET /export-training-data` endpoint to export buffered telemetry ticks to a CSV for external model training, alongside `/training-data/reset` to flush the buffer.
- **Hardware Binding**: Associates a specific hardware node (ESP32) with a simulated vehicle via `BIND_HARDWARE_VEHICLE`, enabling targeted `HARDWARE_DRIVER_ALERT` payloads.

### 3.2. Dynamic Map Fetching (`osmService.ts`)
- Queries the **Overpass API** (`[out:json] way["highway"](...)`) based on a dynamically provided bounding box.
- Features auto-tiling: Splits large bounding boxes into smaller tiles if the area is too large or if the request times out/fails (up to `MAX_SPLIT_DEPTH`).
- Deduplicates road segments and caches the fetched `FeatureCollection<LineString>` locally in the `cache/` directory to save API calls on repeated runs.

### 3.3. Detection Engine (`detectionEngine.ts`)
This is the core rule-based and ML-assisted anomaly detector.
- **Map Matching**: Uses Turf's `nearestPointOnLine` to snap vehicle GPS to the nearest road. Drops data if the distance exceeds `MAP_MATCH_MAX_DISTANCE_KM`.
- **Bearing Delta Calculator**: Computes the difference between the vehicle's heading and the road segment's bearing.
- **Context Switcher**: Suppresses wrong-way alerts on two-way roads (`oneway=no`). Triggers anomalies if delta > 120° on `oneway=yes` or delta < 60° on `oneway=-1`.
- **Dead Reckoning & GNSS Degraded Logic**: 
  - Predicts the next vehicle location based on previous speed/heading (`DEAD_RECKONING_DT_SECONDS`).
  - If the actual GNSS point deviates significantly from the prediction (`GNSS_DEGRADED_DEVIATION_M`), it marks the signal as degraded.
  - Suspends anomaly streak progression during degraded GNSS ticks.
- **Confidence Engine**: Builds confidence via `consecutiveAnomalies`. Incorporates `predictWrongWayProbability` from the ML model if available.
- **Danger Cone (Blast Radius)**: At 100% confidence, computes a dynamic Turf polygon representing the danger zone extending in front of the intruder.
- **Swarm Consensus**: If an anomaly is detected, checks for other vehicles within `SWARM_RADIUS_M`. If witnesses >= `SWARM_MIN_WITNESSES`, forces confidence to 100% and triggers a `SWARM_CONFIRMED` event.
- **Construction Override**: Evaluates if the vehicle is inside a user-drawn `ConstructionOverrideZone`. If true, strictly suppresses wrong-way alerts to prevent false positives in active work zones.

### 3.4. Traffic Simulator (`trafficGenerator.ts`)
- **Modes**:
  - `RANDOM`: Spawns vehicles on random roads. Intruders intentionally prefer one-way roads.
  - `SPECIFIC_PATH`: Spawns a specific count of vehicles strictly along a defined path between Point A and Point B. Uses `geojson-path-finder` to calculate the shortest path via Dijkstra's algorithm.
- **Movement Logic**: Moves vehicles using Turf's `along` function based on their `speedKmh`. Intruders iterate backwards through the `LineString`.

### 3.5. ML Inference (`gnssModel.ts`)
- Parses a Kaggle-exported Random Forest model (converted to a `JsonForestBundle`).
- Implements a pure-TypeScript tree walker (`walkTree`) that navigates nodes based on feature thresholds.
- Averages leaf probabilities across all trees to output class probabilities (`SAFE`, `FALSE_POSITIVE`, `WRONG_WAY`).

---

## 4. Frontend Command Center (React & Vite)

A dark-themed, high-performance UI using MapLibre GL and Tailwind CSS.

### 4.1. State Management (`store.ts`)
Uses `zustand` to maintain a high-frequency `vehicles` dictionary and active `alerts`. Uses `updateTelemetryBatch` to process 10Hz updates without completely freezing the UI.

### 4.2. Map Rendering & Layers (`MapDashboard.tsx`)
- Uses Carto Dark Matter base tiles.
- **Road Network Layer**: Renders the dynamically fetched OSM geojson.
- **Hazard Overlays**: 
  - **Danger Corridors (Red)**: Thick red lines along the road graph predicting the intruder's forward path based on speed.
  - **Feeder Paths (Dashed Yellow)**: Upstream roads that merge into the danger corridor, giving approaching vehicles advanced warning.
  - **GNSS Ghost Paths (Dashed Blue)**: Renders the dead-reckoning predicted path when a vehicle experiences GNSS signal loss.
- **Swarm Pulses**: Renders a ping animation when a swarm consensus event occurs.
- **Construction Zones**: Renders custom drawn polygons with amber/gray fill based on active status.

### 4.3. UI Controls
- **Area Scanner**: Allows users to pan the map and click "Choose This Area" to fetch OSM data via the backend.
- **Simulation Control**: Toggle Random/Specific modes, select A/B path points, and set vehicle density.
- **CSV Replay**: Upload historical CSVs, adjust speed multipliers, and replay them as live telemetry.
- **Construction Drawing**: Interactive map clicking to draw polygon geofences that suppress alerts.

### 4.4. Follow Cam & Dashboard Metrics
Clicking a vehicle locks the camera (`flyTo`/`easeTo`) to its position and bearing. The side panel displays:
- **Kinematics**: Speed, heading, bearing delta vs road, map match offset.
- **GNSS Status**: Signal strength, ML confidence %.
- **Live Telemetry UI List**: Each tracked vehicle in the sidebar displays a color-coded GNSS quality UX bar alongside specific `GNSS degraded` and `DR active` (Dead Reckoning) badges if signal loss or prediction logic occurs.
- **Hazard State**: `SAFE`, `ANOMALY WATCH`, `HAZARD AHEAD`, or `DANGER`. Includes Time-to-Impact (TTI) and distance to the nearest intruder.

---

## 5. Hardware Edge Node (ESP32 V2X)

The `hardware/V2X_Dashboard/V2X_Dashboard.ino` provides a tangible, in-car warning system.

### 5.1. Setup & Connectivity
- Connects to a local Wi-Fi network and establishes a WebSocket connection to the Node.js backend.
- Uses the `Adafruit_SSD1306` library to drive a 128x32 OLED screen via I2C.
- Features a buzzer (`SPEAKER_PIN`) and an acknowledgment button (`BUTTON_PIN`).

### 5.2. Hardware-UI Binding
When the user clicks a vehicle in the React UI, the frontend sends a `BIND_HARDWARE_VEHICLE` message. The ESP32 receives this and binds itself to that specific vehicle's telemetry stream.

### 5.3. Alert States
- **Idle/Normal**: Displays "SYSTEM ONLINE", bound vehicle ID, and "SAFE".
- **Warn/Danger**: If the backend sends a `HARDWARE_DRIVER_ALERT` with `WARN` or `DANGER`:
  - OLED updates to show Distance and TTI.
  - Screen inverts rapidly (strobe effect) for `DANGER`.
  - Buzzer sounds (faster interval for DANGER, slower for WARN).
- **Muted**: Driver presses the physical button to mute the siren and send a `HARDWARE_ACKNOWLEDGE` payload back to the backend (which clears the alert in the UI).

---

## 6. Machine Learning Pipeline (Kaggle)

The ML pipeline replaces simple threshold heuristics with a robust classifier that handles noise and edge cases.

### 6.1. Feature Extraction
The backend buffers telemetry and exports CSVs (`/export-training-data`) with the following features:
`speedKmh`, `bearingDeltaDeg`, `positionJumpM`, `mapMatchDistM`, `streakLength`, `impliedAccelMps2`, `headingVariance`, `speedVariance`.

### 6.2. Model Training
- Trained on Kaggle using `RandomForestClassifier`.
- Achieves high accuracy (e.g., F1-score ~0.94 for `WRONG_WAY`, 1.0 for `FALSE_POSITIVE` based on `metrics.json`).
- Feature importance analysis shows `streakLength` (0.27), `speedKmh` (0.22), and `bearingDeltaDeg` (0.21) as the most critical predictors.
- The model is exported to `model.json` and consumed directly by the Node.js backend.

---

## 7. Conclusion

MaheMobility successfully implements a full-stack, end-to-end V2X safety system. By strictly avoiding hardcoded coordinates, the system is globally scalable to any city via OSM. The integration of Turf.js spatial logic, WebSocket streaming, React/MapLibre visualization, Kaggle Machine Learning, and an ESP32 hardware edge node creates a comprehensive and highly responsive prototype for Next-Gen Wrong-Way Driver Detection.