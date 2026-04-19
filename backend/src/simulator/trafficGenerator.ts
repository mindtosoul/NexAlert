import { lineString, length, along, bearing, distance, point, nearestPointOnLine, lineSlice } from '@turf/turf';
import { Feature, FeatureCollection, LineString, Point, Position } from 'geojson';
import WebSocket from 'ws';
import * as PathFinderModule from 'geojson-path-finder';
import { TelemetryPayload } from '../types.js';

interface SimulatedVehicle {
  id: string;
  route: any; // Turf LineString feature
  totalLength: number;
  currentDistance: number; // km
  speedKmh: number;
  isIntruder: boolean;
}

const vehicles: SimulatedVehicle[] = [];
let wsClient: WebSocket | null = null;
const SIMULATOR_WS_URL = process.env.SIMULATOR_WS_URL ?? 'ws://localhost:8080';
let simulationLoopStarted = false;
export let simulationActive = false;

let roadNetworkRef: any = null;
let cachedOneWayRoads: Feature<LineString>[] = [];
const RANDOM_VEHICLE_COUNT = 30;
const DEFAULT_SPECIFIC_PATH_VEHICLE_COUNT = Number(process.env.DEFAULT_SPECIFIC_PATH_VEHICLE_COUNT ?? 8);

export let simulationMode: 'RANDOM' | 'SPECIFIC_PATH' = 'RANDOM';
export let specificPathRef: any = null;
export let specificPathVehicleCount = Math.max(1, Math.floor(DEFAULT_SPECIFIC_PATH_VEHICLE_COUNT));
let pathFinder: any = null;

const resolvePathFinderCtor = (): any => {
  const mod = PathFinderModule as any;
  const candidates = [mod, mod?.default, mod?.default?.default];
  const ctor = candidates.find((candidate) => typeof candidate === 'function');
  if (!ctor) {
    throw new Error('Unable to resolve geojson-path-finder constructor from module exports.');
  }
  return ctor;
};

const normalizeDistanceOnRoute = (distanceOnRoute: number, routeLength: number) => {
  if (routeLength <= 0) return 0;
  return ((distanceOnRoute % routeLength) + routeLength) % routeLength;
};

const buildSpecificPathStartDistances = (vehicleCount: number, routeLength: number) => {
  if (vehicleCount <= 0 || routeLength <= 0) {
    return [];
  }
  if (vehicleCount === 1) {
    return [Math.random() * routeLength];
  }

  // Stratified randomization: each car gets a lane segment on the route with jitter.
  // This keeps placement random while avoiding unrealistic tight clustering.
  const spacing = routeLength / vehicleCount;
  const anchor = Math.random() * spacing;
  const jitterAmplitude = spacing * 0.6;
  const starts: number[] = [];
  for (let i = 0; i < vehicleCount; i++) {
    const center = anchor + i * spacing;
    const jitter = (Math.random() - 0.5) * jitterAmplitude;
    starts.push(normalizeDistanceOnRoute(center + jitter, routeLength));
  }
  return starts;
};

const spawnVehiclesForCurrentMode = () => {
  clearVehicles();
  if (!roadNetworkRef || !roadNetworkRef.features || roadNetworkRef.features.length === 0) {
    return;
  }
  const numVehicles =
    simulationMode === 'SPECIFIC_PATH' ? specificPathVehicleCount : RANDOM_VEHICLE_COUNT;
  const specificStarts =
    simulationMode === 'SPECIFIC_PATH' && specificPathRef
      ? buildSpecificPathStartDistances(numVehicles, length(specificPathRef))
      : [];
  for (let i = 0; i < numVehicles; i++) {
    spawnVehicle(roadNetworkRef, false, i, numVehicles, specificStarts[i]);
  }
};

export const setSimulationMode = (
  mode: 'RANDOM' | 'SPECIFIC_PATH',
  pointA?: [number, number],
  pointB?: [number, number],
  vehicleCount?: number
) => {
  simulationMode = mode;

  if (mode === 'SPECIFIC_PATH' && Number.isFinite(vehicleCount)) {
    specificPathVehicleCount = Math.max(1, Math.floor(vehicleCount as number));
  }
  
  if (mode === 'SPECIFIC_PATH' && roadNetworkRef && roadNetworkRef.features.length > 0) {
    if (pointA && pointB) {
      const selectedPath = findRoadOnlyPath(pointA, pointB);
      if (!selectedPath) {
        throw new Error('No connected road path found between selected points in current scanned region.');
      }
      specificPathRef = selectedPath;
    } else if (!specificPathRef) {
      fallbackToLongestRoad();
    }
  }
  
  // Configuration only; actual spawning happens on explicit start.
  clearVehicles();
  simulationActive = false;
};

const snapPointToNearestRoad = (coordinates: Position) => {
  const sourcePoint = point(coordinates);
  let nearestRoad: Feature<LineString> | null = null;
  let nearestSnap: Feature<Point> | null = null;
  let minDistance = Number.POSITIVE_INFINITY;

  for (const feature of roadNetworkRef.features as Feature<LineString>[]) {
    if (feature.geometry.type !== 'LineString') {
      continue;
    }

    const snapped = nearestPointOnLine(feature, sourcePoint);
    const dist = distance(sourcePoint, snapped);
    if (dist < minDistance) {
      minDistance = dist;
      nearestRoad = feature;
      nearestSnap = snapped as Feature<Point>;
    }
  }

  return {
    road: nearestRoad,
    snappedPoint: nearestSnap ?? sourcePoint,
  };
};

const getNearestNetworkVertices = (coordinates: Position, limit = 12): Position[] => {
  const sourcePoint = point(coordinates);
  const candidates: Array<{ coord: Position; dist: number }> = [];

  for (const feature of roadNetworkRef.features as Feature<LineString>[]) {
    if (feature.geometry.type !== 'LineString') {
      continue;
    }

    for (const vertex of feature.geometry.coordinates) {
      candidates.push({ coord: vertex, dist: distance(sourcePoint, point(vertex)) });
    }
  }

  const dedup = new Set<string>();
  const nearest: Position[] = [];
  for (const entry of candidates.sort((a, b) => a.dist - b.dist)) {
    const key = `${entry.coord[0].toFixed(7)},${entry.coord[1].toFixed(7)}`;
    if (dedup.has(key)) {
      continue;
    }
    dedup.add(key);
    nearest.push(entry.coord);
    if (nearest.length >= limit) {
      break;
    }
  }

  return nearest;
};

const buildSameRoadSliceFallback = (pointA: Position, pointB: Position) => {
  const snappedStart = snapPointToNearestRoad(pointA);
  const snappedEnd = snapPointToNearestRoad(pointB);

  if (snappedStart.road && snappedEnd.road && snappedStart.road === snappedEnd.road) {
    const slicedPath = lineSlice(snappedStart.snappedPoint, snappedEnd.snappedPoint, snappedStart.road);
    if (slicedPath.geometry.coordinates.length >= 2) {
      return slicedPath;
    }
  }

  return null;
};

const findRoadOnlyPath = (pointA: Position, pointB: Position) => {
  if (!pathFinder) {
    const PathFinderCtor = resolvePathFinderCtor();
    pathFinder = new PathFinderCtor(roadNetworkRef);
  }

  const startCandidates = getNearestNetworkVertices(pointA, 12);
  const endCandidates = getNearestNetworkVertices(pointB, 12);

  let bestPath: Position[] | null = null;
  let bestWeight = Number.POSITIVE_INFINITY;

  for (const startCoord of startCandidates) {
    for (const endCoord of endCandidates) {
      const result = pathFinder.findPath(point(startCoord), point(endCoord));
      if (result && result.path && result.path.length >= 2 && result.weight < bestWeight) {
        bestPath = result.path as Position[];
        bestWeight = result.weight;
      }
    }
  }

  if (bestPath) {
    return lineString(bestPath);
  }

  return buildSameRoadSliceFallback(pointA, pointB);
};

const fallbackToLongestRoad = () => {
  let longestRoad = roadNetworkRef.features[0];
  let maxLength = length(longestRoad);
  for (const feature of roadNetworkRef.features) {
    if (feature.geometry.type === 'LineString') {
      const l = length(feature);
      if (l > maxLength) {
        maxLength = l;
        longestRoad = feature;
      }
    }
  }
  specificPathRef = longestRoad;
};

export const clearVehicles = () => {
  vehicles.length = 0;
};

export const updateSimulationNetwork = (network: FeatureCollection<LineString>) => {
  roadNetworkRef = network;
  cachedOneWayRoads = network.features.filter((f) => f.properties?.oneway === 'yes');
  pathFinder = null; // Reset pathfinder so it rebuilds the graph
  specificPathRef = null;
  clearVehicles();
  simulationActive = false;
  if (simulationMode === 'SPECIFIC_PATH' && !specificPathRef && network.features.length > 0) {
    fallbackToLongestRoad();
  }
};

export const startSimulation = () => {
  if (wsClient) {
    return;
  }
  wsClient = new WebSocket(SIMULATOR_WS_URL);
  wsClient.on('open', () => {
    console.log('Simulator connected to Ingestion Layer');
    if (!simulationLoopStarted) {
      simulationLoopStarted = true;
      setInterval(() => updateVehicles(), 100);
    }
  });
};

export const startConfiguredSimulation = () => {
  if (!roadNetworkRef || !roadNetworkRef.features || roadNetworkRef.features.length === 0) {
    throw new Error('Road network not ready. Scan/select an area first.');
  }
  spawnVehiclesForCurrentMode();
  simulationActive = true;
};

export const stopConfiguredSimulation = () => {
  clearVehicles();
  simulationActive = false;
};

export const resetSimulationState = () => {
  clearVehicles();
  simulationActive = false;
  simulationMode = 'RANDOM';
  specificPathRef = null;
  specificPathVehicleCount = Math.max(1, Math.floor(DEFAULT_SPECIFIC_PATH_VEHICLE_COUNT));
  roadNetworkRef = null;
  cachedOneWayRoads = [];
  pathFinder = null;
};

export const spawnVehicle = (
  network: FeatureCollection<LineString>,
  isIntruder = false,
  index = -1,
  total = 30,
  startDistanceOverride?: number
) => {
  if (!network || !network.features || network.features.length === 0) return;

  let road;
  const useSpecificPath = simulationMode === 'SPECIFIC_PATH' && Boolean(specificPathRef);
  
  if (useSpecificPath) {
    road = specificPathRef;
  } else {
    // Pick a random road
    road = network.features[Math.floor(Math.random() * network.features.length)];
  }
  
  // In RANDOM mode, intruder prefers one-way roads for wrong-way demos.
  // In SPECIFIC_PATH mode, intruder must stay on the selected path.
  if (isIntruder && !useSpecificPath) {
    if (cachedOneWayRoads.length > 0) {
      road = cachedOneWayRoads[Math.floor(Math.random() * cachedOneWayRoads.length)];
    }
  }

  const routeLength = length(road);
  
  let startDistance = 0;
  if (Number.isFinite(startDistanceOverride)) {
    startDistance = normalizeDistanceOnRoute(startDistanceOverride as number, routeLength);
  } else if (isIntruder) {
    startDistance = routeLength;
  } else if (simulationMode === 'SPECIFIC_PATH' && index >= 0 && total > 0) {
    // Fallback random placement when explicit stratified starts are not provided.
    startDistance = Math.random() * routeLength;
  } else {
    // start slightly into the road randomly for normal random traffic
    startDistance = Math.random() * routeLength;
  }

  vehicles.push({
    id: `CAR-${Math.floor(Math.random() * 10000)}`,
    route: road,
    totalLength: routeLength,
    currentDistance: startDistance, // Intruders start from the end
    speedKmh: isIntruder ? 150 : 45 + Math.random() * 30,
    isIntruder
  });
};

const updateVehicles = () => {
  if (!simulationActive) {
    return;
  }
  const dt = 0.1; // 100ms in seconds
  const dtHours = dt / 3600;

  const telemetryBatch: TelemetryPayload[] = [];
  for (let i = vehicles.length - 1; i >= 0; i--) {
    const v = vehicles[i];
    
    // Add check to ensure route and totalLength are valid
    if (!v || !v.route || v.totalLength <= 0) {
      vehicles.splice(i, 1);
      // Spawn a new one to keep traffic flowing
      spawnVehicle(roadNetworkRef, false);
      continue;
    }

    const distDelta = v.speedKmh * dtHours;

    if (v.isIntruder) {
      v.currentDistance -= distDelta;
    } else {
      v.currentDistance += distDelta;
    }

    // Remove if reached end of route
    if (v.currentDistance < 0 || v.currentDistance > v.totalLength) {
      v.currentDistance = v.isIntruder
        ? ((v.currentDistance % v.totalLength) + v.totalLength) % v.totalLength
        : v.currentDistance % v.totalLength;
      continue;
    }

    // Calculate current position and heading
    const currentPoint = along(v.route, Math.max(0, Math.min(v.currentDistance, v.totalLength)));
    // Clamp targetDistance to be strictly within bounds, or slightly nudge it to get a valid bearing
    let targetDistance = v.isIntruder ? v.currentDistance - 0.01 : v.currentDistance + 0.01;
    targetDistance = Math.max(0, Math.min(targetDistance, v.totalLength));
    if (targetDistance === v.currentDistance) {
      targetDistance = v.isIntruder ? v.currentDistance + 0.01 : v.currentDistance - 0.01;
      targetDistance = Math.max(0, Math.min(targetDistance, v.totalLength));
    }
    const nextPoint = along(v.route, targetDistance);
    
    const currentBearing = bearing(currentPoint, nextPoint);
    const [lon, lat] = currentPoint.geometry.coordinates;

    // Remove jitter so cars follow roads smoothly
    const payload: TelemetryPayload = {
      vehicleId: v.id,
      timestamp: Date.now(),
      lat: lat,
      lon: lon,
      heading: currentBearing,
      speedKmh: v.speedKmh
    };

    telemetryBatch.push(payload);
  }

  if (telemetryBatch.length > 0 && wsClient && wsClient.readyState === WebSocket.OPEN) {
    wsClient.send(JSON.stringify({ type: 'TELEMETRY_BATCH', payload: telemetryBatch }));
  }
};
