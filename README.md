<div align="center">
  <h1>🚗 NexAlert</h1>
  <p><strong>Next-Gen Wrong-Way Driver Detection & V2X Alert System</strong></p>
  
  [![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
  [![React](https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB)](https://reactjs.org/)
  [![Node.js](https://img.shields.io/badge/Node.js-43853D?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
  [![MapLibre](https://img.shields.io/badge/MapLibre-000000?style=for-the-badge&logo=maplibre&logoColor=white)](https://maplibre.org/)
  [![Arduino](https://img.shields.io/badge/ESP32-00979D?style=for-the-badge&logo=arduino&logoColor=white)](https://www.arduino.cc/)
</div>

<br />

**NexAlert** is a highly scalable, enterprise-grade Next-Gen Wrong-Way Driver Detection & V2X (Vehicle-to-Everything) Alert System. The core directive of the project is **"Zero Hardcoding. Pure Logical Code."** It dynamically queries OpenStreetMap (OSM) data, runs real-time map matching, and computes anomalies purely through geospatial logic.

The system bridges a simulated environment (or CSV replay telemetry) with real-world ML-based anomaly detection and physical hardware alerts, creating a comprehensive prototype for Next-Gen V2X Safety Systems.

## ✨ Key Features

- **🌍 Zero Hardcoding**: Dynamically fetches road networks anywhere in the world via the Overpass API.
- **📍 Real-time Map Matching**: High-performance spatial math using Turf.js to snap GPS telemetry to road segments.
- **🧠 ML-Assisted Detection**: Incorporates a Kaggle-trained Random Forest classifier for robust anomaly confidence scoring.
- **📡 Swarm Consensus**: Vehicles cross-validate anomalies using V2V (Vehicle-to-Vehicle) proximity logic.
- **⚠️ Hazard Corridors**: Dynamically generates "Danger Cones" and warns upstream feeder traffic of incoming threats.
- **🎛️ Physical V2X Dashboard**: Sub-100ms hardware alerts to an ESP32 OLED display via WebSockets.
- **🏗️ Construction Overrides**: Interactive polygon drawing to suppress false positives in active work zones.

---

## 🏗️ System Architecture

The project is structured as a monorepo containing four major pillars:

1. **`backend/` (Node.js/Express/TypeScript)**: Orchestrates telemetry ingestion via WebSockets, real-time map matching, anomaly detection, ML inference, and traffic simulation.
2. **`frontend/` (React/Vite)**: A dark-themed Command Center dashboard leveraging MapLibre GL for live traffic visualization, alert management, and system control.
3. **`hardware/` (ESP32)**: A physical V2X Edge Node dashboard with an OLED screen and buzzer, receiving driver alerts directly from the backend.
4. **Machine Learning Pipeline**: A trained Random Forest model that evaluates vehicle kinematics and GNSS quality features.

---

## 🚀 Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) (v18+ recommended)
- [npm](https://www.npmjs.com/) or [yarn](https://yarnpkg.com/)
- An ESP32 board (optional, for hardware testing)

### 1. Clone the Repository
```bash
git clone https://github.com/your-username/NexAlert.git
cd NexAlert
```

### 2. Setup the Backend
```bash
cd backend
npm install
npm run dev
```
*The backend server will start on `http://localhost:8080` (or as configured in `.env`).*

### 3. Setup the Frontend
Open a new terminal window:
```bash
cd frontend
npm install
npm run dev
```
*The React app will start on `http://localhost:5173`.*

### 4. Setup the Hardware Node (Optional)
- Open `hardware/V2X_Dashboard/V2X_Dashboard.ino` in the Arduino IDE.
- Install the required libraries (`Adafruit_SSD1306`, `WebSocketsClient`, `ArduinoJson`, etc.).
- Update the Wi-Fi credentials and WebSocket server IP in the code.
- Flash to your ESP32.

---

## 🚦 How It Works

1. **Ingestion**: Telemetry is generated via the built-in simulator or historical CSV replay, feeding into the backend via WebSockets.
2. **Matching**: Incoming coordinates are mapped to the nearest OSM road segment (dynamically fetched & cached).
3. **Detection**: Kinematic rules evaluate bearing deltas against road direction (factoring in `oneway` tags). The ML model evaluates the feature vector to generate confidence scores.
4. **Hazard Generation**: At critical confidence, the system generates a Turf polygon "Danger Cone" and upgrades the vehicle state to `DANGER`.
5. **Broadcasting**: The backend broadcasts enriched telemetry and alerts to the React UI and the bound ESP32 Hardware node in real-time.

---

## 📝 License

This project is licensed under the [MIT License](LICENSE).
