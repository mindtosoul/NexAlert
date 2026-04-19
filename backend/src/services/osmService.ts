import axios from 'axios';
import osmtogeojson from 'osmtogeojson';
import { FeatureCollection, LineString, Feature } from 'geojson';
import fs from 'fs';
import path from 'path';

const CACHE_DIR = path.join(process.cwd(), 'cache');
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

const normalizeEndpoint = (raw: string) =>
  raw
    .trim()
    .replace(/^['"`\s]+|['"`\s]+$/g, '')
    .replace(/\s+/g, '');

const OVERPASS_URL = process.env.OVERPASS_URL ?? 'https://overpass-api.de/api/interpreter';
const OVERPASS_URLS = (
  process.env.OVERPASS_URLS ??
  `${OVERPASS_URL},https://overpass.kumi.systems/api/interpreter,https://overpass.openstreetmap.ru/api/interpreter`
)
  .split(',')
  .map(normalizeEndpoint)
  .filter((s) => /^https?:\/\//i.test(s));
const EFFECTIVE_OVERPASS_URLS = OVERPASS_URLS.length > 0 ? OVERPASS_URLS : ['https://overpass-api.de/api/interpreter'];
const OVERPASS_TIMEOUT_MS = Math.max(5000, Number(process.env.OVERPASS_TIMEOUT_MS ?? 45000));
const MAX_BBOX_AREA_DEG2 = Math.max(0.0001, Number(process.env.OVERPASS_TILE_MAX_AREA_DEG2 ?? 0.0008));
const MAX_TILE_RETRIES = Math.max(0, Number(process.env.OVERPASS_TILE_MAX_RETRIES ?? 2));
const RETRY_BASE_DELAY_MS = Math.max(100, Number(process.env.OVERPASS_RETRY_BASE_DELAY_MS ?? 600));
const MAX_SPLIT_DEPTH = Math.max(2, Number(process.env.OVERPASS_MAX_SPLIT_DEPTH ?? 10));

type BBox = {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
};

export type ScanProgressEvent = {
  phase: 'tile_start' | 'tile_success' | 'tile_retry' | 'tile_split';
  started: number;
  completed: number;
  depth: number;
  endpoint?: string;
  attempt?: number;
  message: string;
};

type ScanProgressContext = {
  started: number;
  completed: number;
};

const bboxAreaDeg2 = (bbox: BBox) =>
  Math.max(0, bbox.maxLat - bbox.minLat) * Math.max(0, bbox.maxLon - bbox.minLon);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const buildOverpassQuery = (bbox: BBox) => `
  [out:json][timeout:${Math.ceil(OVERPASS_TIMEOUT_MS / 1000)}];
  (
    way["highway"](${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon});
  );
  out body;
  >;
  out skel qt;
`;

const splitBbox = (bbox: BBox): BBox[] => {
  const latSpan = bbox.maxLat - bbox.minLat;
  const lonSpan = bbox.maxLon - bbox.minLon;
  const area = latSpan * lonSpan;
  if (area <= MAX_BBOX_AREA_DEG2 || latSpan <= 0 || lonSpan <= 0) {
    return [bbox];
  }
  if (latSpan >= lonSpan) {
    const midLat = (bbox.minLat + bbox.maxLat) / 2;
    return [
      { minLat: bbox.minLat, minLon: bbox.minLon, maxLat: midLat, maxLon: bbox.maxLon },
      { minLat: midLat, minLon: bbox.minLon, maxLat: bbox.maxLat, maxLon: bbox.maxLon },
    ];
  }
  const midLon = (bbox.minLon + bbox.maxLon) / 2;
  return [
    { minLat: bbox.minLat, minLon: bbox.minLon, maxLat: bbox.maxLat, maxLon: midLon },
    { minLat: bbox.minLat, minLon: midLon, maxLat: bbox.maxLat, maxLon: bbox.maxLon },
  ];
};

const shouldSplitOrRetry = (error: any) => {
  const status = error?.response?.status;
  const code = String(error?.code ?? '');
  const message = String(error?.message ?? '').toLowerCase();
  return (
    status === 429 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    code === 'ECONNABORTED' ||
    message.includes('timeout')
  );
};

const fetchTileRoads = async (
  bbox: BBox,
  attempt = 0,
  depth = 0,
  progress?: ScanProgressContext,
  onProgress?: (event: ScanProgressEvent) => void
): Promise<Feature<LineString>[]> => {
  const query = buildOverpassQuery(bbox);
  const endpoint = EFFECTIVE_OVERPASS_URLS[attempt % EFFECTIVE_OVERPASS_URLS.length] ?? 'https://overpass-api.de/api/interpreter';
  try {
    if (progress && onProgress) {
      progress.started += 1;
      onProgress({
        phase: 'tile_start',
        started: progress.started,
        completed: progress.completed,
        depth,
        endpoint,
        attempt,
        message: `Fetching tile ${progress.completed + 1}/${progress.started}...`,
      });
    }
    const response = await axios.post(endpoint, `data=${encodeURIComponent(query)}`, {
      timeout: OVERPASS_TIMEOUT_MS,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      family: 4,
    });
    const geojson = osmtogeojson(response.data) as FeatureCollection;
    const roads = geojson.features.filter(
      (f) => f.geometry && f.geometry.type === 'LineString'
    ) as Feature<LineString>[];
    if (progress && onProgress) {
      progress.completed += 1;
      onProgress({
        phase: 'tile_success',
        started: progress.started,
        completed: progress.completed,
        depth,
        endpoint,
        attempt,
        message: `Fetched tile ${progress.completed}/${progress.started}.`,
      });
    }
    return roads;
  } catch (error: any) {
    const shouldRetry = attempt < MAX_TILE_RETRIES && shouldSplitOrRetry(error);
    if (shouldRetry) {
      if (progress && onProgress) {
        onProgress({
          phase: 'tile_retry',
          started: progress.started,
          completed: progress.completed,
          depth,
          endpoint,
          attempt,
          message: `Retrying tile (${attempt + 1}/${MAX_TILE_RETRIES})...`,
        });
      }
      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
      await sleep(delay);
      return fetchTileRoads(bbox, attempt + 1, depth, progress, onProgress);
    }
    throw error;
  }
};

const fetchRoadsRecursive = async (
  bbox: BBox,
  depth = 0,
  progress?: ScanProgressContext,
  onProgress?: (event: ScanProgressEvent) => void
): Promise<Feature<LineString>[]> => {
  // Proactively split oversized tiles before first request to avoid guaranteed timeout paths.
  if (bboxAreaDeg2(bbox) > MAX_BBOX_AREA_DEG2 && depth < MAX_SPLIT_DEPTH) {
    const childTiles = splitBbox(bbox);
    if (childTiles.length > 1) {
      if (progress && onProgress) {
        onProgress({
          phase: 'tile_split',
          started: progress.started,
          completed: progress.completed,
          depth,
          message: `Splitting region at depth ${depth + 1}...`,
        });
      }
      const merged: Feature<LineString>[] = [];
      for (const tile of childTiles) {
        const part = await fetchRoadsRecursive(tile, depth + 1, progress, onProgress);
        merged.push(...part);
        await sleep(50);
      }
      return merged;
    }
  }

  try {
    return await fetchTileRoads(bbox, 0, depth, progress, onProgress);
  } catch (error: any) {
    // If this tile is still too heavy, split recursively and merge.
    if (!shouldSplitOrRetry(error)) {
      throw error;
    }
    const childTiles = splitBbox(bbox);
    if (childTiles.length === 1 || depth >= MAX_SPLIT_DEPTH) {
      throw error;
    }
    if (progress && onProgress) {
      onProgress({
        phase: 'tile_split',
        started: progress.started,
        completed: progress.completed,
        depth,
        message: `Retry with smaller tiles (depth ${depth + 1})...`,
      });
    }
    const merged: Feature<LineString>[] = [];
    for (const tile of childTiles) {
      const part = await fetchRoadsRecursive(tile, depth + 1, progress, onProgress);
      merged.push(...part);
      // Slight pacing avoids hammering shared public Overpass infrastructure.
      await sleep(50);
    }
    return merged;
  }
};

const featureKey = (feature: Feature<LineString>) => {
  const idPart = feature.id != null ? String(feature.id) : '';
  const coords = feature.geometry.coordinates;
  if (coords.length === 0) {
    return idPart || 'empty';
  }
  const first = coords[0];
  const last = coords[coords.length - 1];
  return `${idPart}|${coords.length}|${first[0].toFixed(6)},${first[1].toFixed(6)}|${last[0].toFixed(6)},${last[1].toFixed(6)}`;
};

const dedupeRoads = (roads: Feature<LineString>[]) => {
  const seen = new Set<string>();
  const unique: Feature<LineString>[] = [];
  for (const road of roads) {
    const key = featureKey(road);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(road);
    }
  }
  return unique;
};

// Fetch road network for a given bounding box
export const fetchRoadNetwork = async (bbox: {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}, onProgress?: (event: ScanProgressEvent) => void): Promise<FeatureCollection<LineString>> => {
  const cacheKey = `osm_${bbox.minLat}_${bbox.minLon}_${bbox.maxLat}_${bbox.maxLon}.json`;
  const cachePath = path.join(CACHE_DIR, cacheKey);

  if (fs.existsSync(cachePath)) {
    console.log(`Loading OSM data from cache: ${cacheKey}`);
    const cachedData = fs.readFileSync(cachePath, 'utf-8');
    return JSON.parse(cachedData);
  }

  try {
    const area = bboxAreaDeg2(bbox);
    console.log(`Fetching OSM roads for bbox (${bbox.minLat}, ${bbox.minLon}, ${bbox.maxLat}, ${bbox.maxLon}), area=${area.toFixed(6)} deg^2`);
    const progress: ScanProgressContext = { started: 0, completed: 0 };
    const roads = await fetchRoadsRecursive(bbox, 0, progress, onProgress);
    const uniqueRoads = dedupeRoads(roads);
    console.log(`Successfully fetched ${uniqueRoads.length} road segments (${roads.length - uniqueRoads.length} duplicates removed).`);

    const result = {
      type: 'FeatureCollection' as const,
      features: uniqueRoads,
    };

    fs.writeFileSync(cachePath, JSON.stringify(result));
    return result;
  } catch (error) {
    console.error('Error fetching OSM data:', error);
    throw error;
  }
};
