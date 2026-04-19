import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import { FeatureCollection, LineString } from 'geojson';
import { TelemetryPayload } from './types.js';
import {
  processTelemetry,
  setRoadNetwork,
  getDetectionStats,
  recordDetectionFeedback,
  resetDetectionStats,
  getConstructionOverrideState,
  setConstructionOverrideActive,
  upsertConstructionOverrideZone,
  removeConstructionOverrideZone,
} from './services/detectionEngine.js';
import { fetchRoadNetwork } from './services/osmService.js';
import { startSimulation, startConfiguredSimulation, stopConfiguredSimulation, spawnVehicle, updateSimulationNetwork, setSimulationMode, simulationMode, specificPathVehicleCount, simulationActive, resetSimulationState } from './simulator/trafficGenerator.js';

const app = express();
const port = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Store active connections (e.g. ESP32, React Frontend, Simulators)
const clients: Set<WebSocket> = new Set();

type CsvReplayRow = TelemetryPayload;
type CsvReplayState = {
  running: boolean;
  startedAtMs: number;
  cursor: number;
  baseTimestampMs: number;
  speedMultiplier: number;
  rows: CsvReplayRow[];
  timer?: NodeJS.Timeout;
};
const csvReplayState: CsvReplayState = {
  running: false,
  startedAtMs: 0,
  cursor: 0,
  baseTimestampMs: 0,
  speedMultiplier: 1,
  rows: [],
};
let hardwareBoundVehicleId: string | null = null;

const isFiniteNumber = (value: any) => typeof value === 'number' && Number.isFinite(value);
const isCoordinateArray = (value: any): value is [number, number][] =>
  Array.isArray(value) &&
  value.length >= 3 &&
  value.every((p) => Array.isArray(p) && p.length === 2 && isFiniteNumber(p[0]) && isFiniteNumber(p[1]));

const validateTelemetry = (payload: any): payload is TelemetryPayload => {
  if (!payload || typeof payload !== 'object') return false;
  if (typeof payload.vehicleId !== 'string' || payload.vehicleId.trim().length === 0) return false;
  if (!isFiniteNumber(payload.timestamp)) return false;
  if (!isFiniteNumber(payload.lat) || payload.lat < -90 || payload.lat > 90) return false;
  if (!isFiniteNumber(payload.lon) || payload.lon < -180 || payload.lon > 180) return false;
  if (!isFiniteNumber(payload.heading) || payload.heading < -360 || payload.heading > 720) return false;
  if (!isFiniteNumber(payload.speedKmh) || payload.speedKmh < 0 || payload.speedKmh > 350) return false;
  return true;
};

const stopCsvReplay = () => {
  if (csvReplayState.timer) {
    clearInterval(csvReplayState.timer);
    csvReplayState.timer = undefined;
  }
  csvReplayState.running = false;
  csvReplayState.cursor = 0;
  csvReplayState.rows = [];
  csvReplayState.baseTimestampMs = 0;
  csvReplayState.startedAtMs = 0;
  csvReplayState.speedMultiplier = 1;
};

const parseCsvTelemetry = (csvText: string): CsvReplayRow[] => {
  const lines = csvText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) {
    throw new Error('CSV must include header and at least one data row.');
  }
  const headers = lines[0].split(',').map((h) => h.trim());
  const idx = {
    vehicleId: headers.indexOf('vehicleId'),
    timestamp: headers.indexOf('timestamp'),
    lat: headers.indexOf('lat'),
    lon: headers.indexOf('lon'),
    heading: headers.indexOf('heading'),
    speedKmh: headers.indexOf('speedKmh'),
  };
  if (Object.values(idx).some((v) => v < 0)) {
    throw new Error('CSV header must contain vehicleId,timestamp,lat,lon,heading,speedKmh.');
  }
  const out: CsvReplayRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map((c) => c.trim());
    if (cols.length < headers.length) continue;
    const row: TelemetryPayload = {
      vehicleId: cols[idx.vehicleId],
      timestamp: Number(cols[idx.timestamp]),
      lat: Number(cols[idx.lat]),
      lon: Number(cols[idx.lon]),
      heading: Number(cols[idx.heading]),
      speedKmh: Number(cols[idx.speedKmh]),
    };
    if (!validateTelemetry(row)) continue;
    out.push(row);
  }
  if (out.length === 0) {
    throw new Error('No valid telemetry rows found in CSV.');
  }
  out.sort((a, b) => a.timestamp - b.timestamp);
  return out;
};

const startCsvReplay = (rows: CsvReplayRow[], speedMultiplier = 1) => {
  stopCsvReplay();
  csvReplayState.running = true;
  csvReplayState.rows = rows;
  csvReplayState.cursor = 0;
  csvReplayState.baseTimestampMs = rows[0].timestamp;
  csvReplayState.startedAtMs = Date.now();
  csvReplayState.speedMultiplier = Math.max(0.1, speedMultiplier);

  csvReplayState.timer = setInterval(() => {
    if (!csvReplayState.running) return;
    const elapsedMs = (Date.now() - csvReplayState.startedAtMs) * csvReplayState.speedMultiplier;
    const targetTimestamp = csvReplayState.baseTimestampMs + elapsedMs;
    const batch: TelemetryPayload[] = [];
    while (
      csvReplayState.cursor < csvReplayState.rows.length &&
      csvReplayState.rows[csvReplayState.cursor].timestamp <= targetTimestamp
    ) {
      const telemetry = csvReplayState.rows[csvReplayState.cursor];
      processTelemetry(telemetry);
      batch.push(telemetry);
      csvReplayState.cursor += 1;
    }
    if (batch.length > 0) {
      broadcast({ type: 'TELEMETRY_BATCH', payload: batch });
    }
    if (csvReplayState.cursor >= csvReplayState.rows.length) {
      stopCsvReplay();
      broadcast({ type: 'CSV_REPLAY_COMPLETE' });
    }
  }, 100);
};

wss.on('connection', (ws) => {
  console.log('New client connected.');
  clients.add(ws);
  ws.send(JSON.stringify({ type: 'HARDWARE_BINDING_UPDATED', payload: { vehicleId: hardwareBoundVehicleId } }));

  ws.on('message', (message: string) => {
    try {
      const data = JSON.parse(message);

      // Ingestion Layer - Handle incoming telemetry data
      if (data.type === 'TELEMETRY') {
        const telemetry = data.payload;
        if (!validateTelemetry(telemetry)) {
          ws.send(JSON.stringify({ type: 'ERROR', code: 'INVALID_TELEMETRY', message: 'Invalid TELEMETRY payload schema.' }));
          return;
        }
        
        // Pass telemetry to Detection Engine
        processTelemetry(telemetry);

        // Broadcast telemetry so the UI can render the cars!
        broadcast(data);
      } else if (data.type === 'TELEMETRY_BATCH' && Array.isArray(data.payload)) {
        const telemetryBatch = (data.payload as any[]).filter(validateTelemetry) as TelemetryPayload[];
        if (telemetryBatch.length === 0) {
          ws.send(JSON.stringify({ type: 'ERROR', code: 'INVALID_TELEMETRY_BATCH', message: 'No valid telemetry entries in TELEMETRY_BATCH.' }));
          return;
        }
        for (const telemetry of telemetryBatch) {
          processTelemetry(telemetry);
        }
        // Forward the batch as-is to keep frontend update overhead low.
        broadcast({ type: 'TELEMETRY_BATCH', payload: telemetryBatch });
      } else if (data.type === 'ACKNOWLEDGE') {
        if (data.outcome === 'false_positive' || data.outcome === 'confirmed') {
          recordDetectionFeedback(data.outcome);
        }
        console.log(`Driver acknowledged alert from ${data.vehicleId}`);
        // Clear alert in UI when driver acknowledges.
        if (typeof data.vehicleId === 'string' && data.vehicleId.trim().length > 0) {
          broadcast({
            type: 'SAFE',
            vehicleId: data.vehicleId,
            confidenceScore: 0,
            message: 'Alert acknowledged by driver.',
          });
        }
        broadcast(data);
      } else if (data.type === 'BIND_HARDWARE_VEHICLE') {
        const nextVehicleId = typeof data.payload?.vehicleId === 'string' && data.payload.vehicleId.trim().length > 0
          ? data.payload.vehicleId.trim()
          : null;
        hardwareBoundVehicleId = nextVehicleId;
        broadcast({ type: 'HARDWARE_BINDING_UPDATED', payload: { vehicleId: hardwareBoundVehicleId } });
      } else if (data.type === 'HARDWARE_DRIVER_ALERT') {
        const payload = data.payload ?? {};
        if (typeof payload.vehicleId !== 'string' || payload.vehicleId.trim().length === 0) {
          ws.send(JSON.stringify({ type: 'ERROR', code: 'INVALID_HARDWARE_ALERT', message: 'payload.vehicleId is required.' }));
          return;
        }
        if (hardwareBoundVehicleId && payload.vehicleId !== hardwareBoundVehicleId) {
          return;
        }
        const mode = payload.mode === 'DANGER' || payload.mode === 'WARN' ? payload.mode : 'SAFE';
        broadcast({
          type: 'HARDWARE_DRIVER_ALERT',
          payload: {
            vehicleId: payload.vehicleId,
            mode,
            distanceM: isFiniteNumber(payload.distanceM) ? payload.distanceM : null,
            ttiSeconds: isFiniteNumber(payload.ttiSeconds) ? payload.ttiSeconds : null,
            message: typeof payload.message === 'string' ? payload.message : '',
            headingDeltaDeg: isFiniteNumber(payload.headingDeltaDeg) ? payload.headingDeltaDeg : null,
          },
        });
      } else if (data.type === 'HARDWARE_ACKNOWLEDGE') {
        const vehicleId = typeof data.vehicleId === 'string' ? data.vehicleId.trim() : '';
        if (vehicleId.length > 0) {
          broadcast({ type: 'HARDWARE_DRIVER_ACKNOWLEDGED', vehicleId });
        }
      } else if (data.type === 'SET_CONSTRUCTION_OVERRIDE') {
        const payload = data.payload ?? {};
        if (!isCoordinateArray(payload.coordinates)) {
          ws.send(JSON.stringify({ type: 'ERROR', code: 'INVALID_CONSTRUCTION_OVERRIDE', message: 'coordinates must be an array of [lon,lat] points.' }));
          return;
        }
        const zone = upsertConstructionOverrideZone({
          id: typeof payload.id === 'string' ? payload.id : undefined,
          name: typeof payload.name === 'string' ? payload.name : undefined,
          coordinates: payload.coordinates,
          active: typeof payload.active === 'boolean' ? payload.active : true,
          reason: typeof payload.reason === 'string' ? payload.reason : undefined,
        });
        if (typeof payload.globalActive === 'boolean') {
          setConstructionOverrideActive(payload.globalActive);
        }
        broadcast({ type: 'CONSTRUCTION_OVERRIDE_UPDATED', payload: getConstructionOverrideState() });
        ws.send(JSON.stringify({ type: 'CONSTRUCTION_OVERRIDE_SAVED', payload: zone }));
      } else if (data.type === 'CLEAR_CONSTRUCTION_OVERRIDE') {
        if (typeof data.zoneId === 'string' && data.zoneId.trim().length > 0) {
          removeConstructionOverrideZone(data.zoneId.trim());
        } else if (typeof data.payload?.zoneId === 'string' && data.payload.zoneId.trim().length > 0) {
          removeConstructionOverrideZone(data.payload.zoneId.trim());
        } else {
          ws.send(JSON.stringify({ type: 'ERROR', code: 'INVALID_CONSTRUCTION_OVERRIDE', message: 'zoneId is required.' }));
          return;
        }
        broadcast({ type: 'CONSTRUCTION_OVERRIDE_UPDATED', payload: getConstructionOverrideState() });
      }
    } catch (error) {
      console.error('Error processing message:', error);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected.');
    clients.delete(ws);
  });
});

// Helper to broadcast messages to all connected clients
export const broadcast = (data: any) => {
  const message = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
};

app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'V2X Backend Running' });
});

app.get('/network', (req, res) => {
  res.json(globalNetwork || { type: 'FeatureCollection', features: [] });
});

let globalNetwork: any = null;

// Inject intruder endpoint
app.post('/inject-intruder', (req, res) => {
  console.log("INJECT INTRUDER API CALLED");
  if (globalNetwork && simulationActive) {
    spawnVehicle(globalNetwork, true);
    res.json({ status: 'ok', message: 'Intruder injected' });
  } else {
    res.status(400).json({ error: 'Simulation not running. Start simulation first.' });
  }
});

// Toggle simulation mode endpoint
app.post('/set-simulation-mode', (req, res) => {
  const { mode, pointA, pointB, vehicleCount } = req.body;
  if (mode === 'RANDOM' || mode === 'SPECIFIC_PATH') {
    try {
      setSimulationMode(mode, pointA, pointB, vehicleCount);
      broadcast({ type: 'SIMULATION_RESET', mode, vehicleCount: specificPathVehicleCount, simulationActive: false });
      res.json({ status: 'ok', mode, vehicleCount: specificPathVehicleCount });
    } catch (err: any) {
      console.error('Failed to set simulation mode:', err);
      res.status(422).json({
        error: err?.message || 'Unable to build a connected road-only path for selected points.',
      });
    }
  } else {
    res.status(400).json({ error: 'Invalid mode' });
  }
});

app.get('/simulation-status', (req, res) => {
  res.json({ mode: simulationMode, specificPathVehicleCount, simulationActive, hasNetwork: Boolean(globalNetwork?.features?.length) });
});

app.post('/reset-session', (req, res) => {
  const emptyNetwork: FeatureCollection<LineString> = { type: 'FeatureCollection', features: [] };
  stopCsvReplay();
  globalNetwork = null;
  resetSimulationState();
  setRoadNetwork(emptyNetwork);
  resetDetectionStats();
  broadcast({ type: 'SIMULATION_RESET', mode: 'RANDOM', vehicleCount: specificPathVehicleCount, simulationActive: false });
  res.json({ status: 'ok' });
});

app.post('/start-simulation', (req, res) => {
  const { mode, pointA, pointB, vehicleCount } = req.body ?? {};
  try {
    stopCsvReplay();
    if (mode === 'RANDOM' || mode === 'SPECIFIC_PATH') {
      setSimulationMode(mode, pointA, pointB, vehicleCount);
    }
    startConfiguredSimulation();
    resetDetectionStats();
    broadcast({ type: 'SIMULATION_RESET', mode: simulationMode, vehicleCount: specificPathVehicleCount, simulationActive: true });
    res.json({ status: 'ok', mode: simulationMode, vehicleCount: specificPathVehicleCount, simulationActive: true });
  } catch (err: any) {
    res.status(422).json({ error: err?.message || 'Failed to start simulation' });
  }
});

app.post('/stop-simulation', (req, res) => {
  stopConfiguredSimulation();
  broadcast({ type: 'SIMULATION_RESET', mode: simulationMode, vehicleCount: specificPathVehicleCount, simulationActive: false });
  res.json({ status: 'ok', simulationActive: false, mode: simulationMode, vehicleCount: specificPathVehicleCount });
});

app.post('/csv-replay/start', (req, res) => {
  const { csvText, speedMultiplier } = req.body ?? {};
  if (typeof csvText !== 'string' || csvText.trim().length === 0) {
    return res.status(400).json({ error: 'csvText is required.' });
  }
  try {
    stopConfiguredSimulation();
    const rows = parseCsvTelemetry(csvText);
    startCsvReplay(rows, Number(speedMultiplier) || 1);
    res.json({ status: 'ok', rows: rows.length, speedMultiplier: csvReplayState.speedMultiplier });
  } catch (err: any) {
    res.status(422).json({ error: err?.message || 'Failed to parse/start CSV replay.' });
  }
});

app.post('/csv-replay/stop', (req, res) => {
  stopCsvReplay();
  res.json({ status: 'ok', running: false });
});

app.get('/csv-replay/status', (req, res) => {
  res.json({
    running: csvReplayState.running,
    cursor: csvReplayState.cursor,
    totalRows: csvReplayState.rows.length,
    speedMultiplier: csvReplayState.speedMultiplier,
  });
});

app.get('/stats', (req, res) => {
  const stats = getDetectionStats();
  res.json({
    ...stats,
    // Active vehicles from current telemetry stream visible in UI
    vehiclesMonitored: stats.vehiclesMonitored,
  });
});

app.get('/construction-override', (req, res) => {
  res.json(getConstructionOverrideState());
});

app.post('/construction-override', (req, res) => {
  const { id, name, coordinates, active, reason, globalActive } = req.body ?? {};
  if (!isCoordinateArray(coordinates)) {
    return res.status(400).json({ error: 'coordinates must be an array of [lon,lat] points (minimum 3).' });
  }
  try {
    const zone = upsertConstructionOverrideZone({
      id: typeof id === 'string' ? id : undefined,
      name: typeof name === 'string' ? name : undefined,
      coordinates,
      active: typeof active === 'boolean' ? active : true,
      reason: typeof reason === 'string' ? reason : undefined,
    });
    if (typeof globalActive === 'boolean') {
      setConstructionOverrideActive(globalActive);
    }
    const state = getConstructionOverrideState();
    broadcast({ type: 'CONSTRUCTION_OVERRIDE_UPDATED', payload: state });
    return res.json({ status: 'ok', zone, state });
  } catch (err: any) {
    return res.status(422).json({ error: err?.message ?? 'Invalid construction override payload.' });
  }
});

app.post('/construction-override/active', (req, res) => {
  const { active } = req.body ?? {};
  if (typeof active !== 'boolean') {
    return res.status(400).json({ error: 'active must be boolean.' });
  }
  const state = setConstructionOverrideActive(active);
  broadcast({ type: 'CONSTRUCTION_OVERRIDE_UPDATED', payload: state });
  return res.json({ status: 'ok', state });
});

app.delete('/construction-override/:id', (req, res) => {
  const zoneId = String(req.params.id ?? '').trim();
  if (!zoneId) {
    return res.status(400).json({ error: 'zone id is required.' });
  }
  const removed = removeConstructionOverrideZone(zoneId);
  if (!removed) {
    return res.status(404).json({ error: 'zone not found.' });
  }
  const state = getConstructionOverrideState();
  broadcast({ type: 'CONSTRUCTION_OVERRIDE_UPDATED', payload: state });
  return res.json({ status: 'ok', state });
});

// Update region endpoint
app.post('/update-region', async (req, res) => {
  const { minLat, minLon, maxLat, maxLon } = req.body;
  if (minLat == null || minLon == null || maxLat == null || maxLon == null) {
    return res.status(400).json({ error: 'Missing bbox coordinates' });
  }

  try {
    const network = await fetchRoadNetwork({ minLat, minLon, maxLat, maxLon }, (progress) => {
      broadcast({ type: 'SCAN_PROGRESS', ...progress });
    });
    globalNetwork = network;
    setRoadNetwork(network);
    updateSimulationNetwork(network); // Clear old cars, spawn new ones
    resetDetectionStats();
    broadcast({ type: 'SIMULATION_RESET', mode: simulationMode, vehicleCount: specificPathVehicleCount, simulationActive: false });
    res.json({ status: 'ok', network });
  } catch (err) {
    console.error('Failed to update region:', err);
    res.status(500).json({ error: 'Failed to fetch road network for this region' });
  }
});

server.listen(port, async () => {
  console.log(`Server started on http://localhost:${port}`);
  console.log(`WebSocket server running on ws://localhost:${port}`);
  // Start simulator transport only; network + simulation start are user-driven from dashboard.
  startSimulation();
});
