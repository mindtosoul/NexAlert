# Implementation Plan: Next-Gen Wrong-Way Driver Detection & V2X Alert System

## 1. Summary & Objectives

The goal is to build a highly scalable, enterprise-grade wrong-way driver detection system that uses GPS telemetry and OpenStreetMap (OSM) data, integrated with a physical ESP32 V2X (Vehicle-to-Everything) hardware node.

**Core Directive:** **Zero Hardcoding. Pure Logical Code.**
The system must dynamically fetch road geometries, dynamically evaluate headings based on road tags (`oneway=yes`, `oneway=no`), and feature a fully abstracted GPS Ingestion Layer capable of seamlessly switching between simulated and real-world data.

## 2. Current State Analysis

* **Status Update (Current):** The repository is now a working monorepo with `backend/`, `frontend/`, and `hardware/` implemented.
* **Progress Summary:** Most core backend, simulation, frontend, and ESP32 features are implemented. Remaining work is focused on validation gaps and a few planned UI/ops features.

## 3. Architecture Decisions & Assumptions

* **Dynamic Data Fetching (No Hardcoding):** Instead of hardcoding road coordinates, the backend will use the **Overpass API** to dynamically fetch OSM road vectors for a given bounding box (e.g., a specific highway in Bangalore).

* **Geospatial Processing:** We will use **Turf.js** on the backend to handle all vector math (map-matching, bearing calculation, polygon intersections).

* **Real-Time Communication:** **WebSockets (ws)** will be used as the backbone to ensure sub-100ms latency between the Simulation Engine, the Core Logic Engine, the React Frontend, and the ESP32 Hardware.

* **Unified Telemetry Schema:** All incoming data (whether from the simulator or a real car) must strictly adhere to a standardized JSON schema.

## 4. Task Breakdown & Implementation Steps

### Part 1: Project Initialization & Core Backend Setup

* [x] **Task 1.1 (Done):** Monorepo structure initialized (`backend/`, `frontend/`, `hardware/`).

* [x] **Task 1.2 (Done):** Node.js/Express backend with TypeScript and core dependencies (`ws`, `express`, `@turf/turf`, `axios`, `cors`) is set up.

* [~] **Task 1.3 (Partial):** WebSocket ingestion layer exists in `server.ts` and receives telemetry, but strict runtime schema validation is still missing.

### Part 2: The Core Logic Engine (No Hardcoding)

* [x] **Task 2.1 (Done):** `osmService.ts` dynamically queries Overpass API for road vectors in a bounding box.

* [x] **Task 2.2 (Done):** Map matcher in `detectionEngine.ts` snaps incoming GPS to nearest OSM segment.

* [x] **Task 2.3 (Done):** Bearing delta calculation compares vehicle heading to road direction.

* [x] **Task 2.4 (Done):** Confidence score engine is implemented with consecutive anomaly streak logic (default threshold 3).

* [x] **Task 2.5 (Done):** Context switcher suppresses strict wrong-way alerts on two-way roads (`oneway=no`/undefined).

### Part 3: The Simulation Engine

* [x] **Task 3.1 (Done):** `trafficGenerator.ts` moves normal vehicles along fetched OSM paths.

* [x] **Task 3.2 (Done):** "Inject Intruder" is implemented via API + simulator spawn logic.

* [x] **Task 3.3 (Done):** Simulation feeds ingestion layer via WebSockets at 10Hz.

### Part 4: Visual Command Center (React + MapLibre Frontend)

* [x] **Task 4.1 (Done):** Vite + React + TypeScript frontend is initialized with required dependencies and CARTO/OSM tiles.

* [x] **Task 4.2 (Done):** `MapDashboard.tsx` renders map, connects to backend WebSocket stream, and supports viewport scan (`Choose This Area`).

* [x] **Task 4.3 (Done):** Live traffic rendering is implemented: normal cars (green), intruders (pulsing red), smooth UI motion.

* [x] **Task 4.4 (Done, Updated Design):** Alert visualization now uses road-aligned hazard corridors: intruder path segments in red and connected feeder-risk roads in yellow.

* [~] **Task 4.5 (Partial):** Live telemetry panel exists and shows confidence/status; explicit bearing-delta display still needs completion.

* [ ] **Task 4.6 (Not Started):** Construction Override Tool (polygon draw + backend geofence suppression) is not implemented yet.

### Part 5: V2X Edge Node (ESP32 Hardware)

* [x] **Task 5.1 (Done):** ESP32 code connects to WiFi and Node.js WebSocket server.

* [x] **Task 5.2 (Done):** `Adafruit_SSD1306` integrated and normal status UI displayed on OLED.

* [x] **Task 5.3 (Done):** Hardware reacts to `"DANGER"` by inverting OLED + triggering siren behavior.

* [~] **Task 5.4 (Partial):** Push button sends `"ACKNOWLEDGE"` to backend; frontend-side alarm-clearing UX is still incomplete.

## 5. Verification & Testing

* [~] **Backend Test (Partial):** Core flows are active in running app, but an explicit headless verification checklist/runbook is still pending.

* [ ] **Frontend Test (Pending):** End-to-end stress verification for 20+ cars and Construction Override geofence flow not completed.

* [~] **Hardware Test (Partial):** Feature path exists; formal measured latency validation (<100ms) still pending.

* [~] **Zero-Hardcoding Audit (Partial):** Dynamic bbox/network switching is implemented, but documented cross-city audit run is still pending.

## 6. Remaining Work (Actionable)

* Add strict runtime validation for incoming telemetry payloads at ingestion.
* (Optional cleanup) Remove or deprecate unused backend `blastRadius` cone payload if no longer part of product design.
* Add explicit bearing-delta values in the telemetry panel.
* Implement Construction Override geofence tool (frontend draw + backend suppression logic).
* Complete ACKNOWLEDGE-to-UI clearing flow and validate expected UX.
* Run and document formal backend/frontend/hardware verification passes.
