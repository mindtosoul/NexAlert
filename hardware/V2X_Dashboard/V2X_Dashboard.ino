#include <WiFi.h>
#include <WebSocketsClient.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <ArduinoJson.h>

// --- Config ---
const char* ssid = "MAHEAA";
const char* password = "Aditya123";
const char* ws_host = "10.84.181.154"; // Node.js server LAN IP
const uint16_t ws_port = 8080;

// --- Hardware Pins ---
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 32
#define OLED_RESET -1
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);

const int SPEAKER_PIN = 25; // Buzzer directly to ESP32 GPIO (low-current buzzer only)
const int BUTTON_PIN = 26;  // Connect to Push Button (Pull-up)

// --- State ---
WebSocketsClient webSocket;
bool isDangerMode = false;
bool isWarnMode = false;
bool driverMuted = false;
unsigned long lastSirenToggle = 0;
bool sirenState = false;
String boundVehicleId = "";
String lastMessage = "Waiting for binding";
float lastDistanceM = -1.0f;
float lastTtiSeconds = -1.0f;
unsigned long lastScreenRefreshMs = 0;

const String DEVICE_ID = "ESP32-V2X-1";

void setup() {
  Serial.begin(115200);
  
  pinMode(SPEAKER_PIN, OUTPUT);
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  
  // Init OLED
  if(!display.begin(SSD1306_SWITCHCAPVCC, 0x3C)) {
    Serial.println(F("SSD1306 allocation failed"));
    for(;;);
  }
  display.clearDisplay();
  display.setTextColor(WHITE);
  display.setTextSize(1);
  display.setCursor(0,0);
  display.println("V2X Node Starting...");
  display.display();

  // Connect WiFi
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi Connected!");

  // Connect WebSocket
  webSocket.begin(ws_host, ws_port, "/");
  webSocket.onEvent(webSocketEvent);
  webSocket.setReconnectInterval(5000);
  
  drawIdleDashboard();
}

void loop() {
  webSocket.loop();

  // Handle Button Press (mute active warning until SAFE arrives)
  if (digitalRead(BUTTON_PIN) == LOW && (isDangerMode || isWarnMode)) {
    delay(50); // debounce
    if (digitalRead(BUTTON_PIN) == LOW) {
      driverMuted = true;
      sendHardwareAcknowledge();
      digitalWrite(SPEAKER_PIN, LOW);
      drawMutedDashboard();
    }
  }

  // Handle buzzer in WARN/DANGER mode
  if (!driverMuted && (isDangerMode || isWarnMode)) {
    unsigned long interval = isDangerMode ? 180 : 500;
    if (millis() - lastSirenToggle > interval) {
      lastSirenToggle = millis();
      sirenState = !sirenState;
      digitalWrite(SPEAKER_PIN, sirenState ? HIGH : LOW);
      if (isDangerMode) {
        display.invertDisplay(sirenState);
      } else {
        display.invertDisplay(false);
      }
    }
  } else {
    digitalWrite(SPEAKER_PIN, LOW);
    display.invertDisplay(false);
  }

  // Periodic OLED refresh so distance/TTI stays readable.
  if (millis() - lastScreenRefreshMs > 1000) {
    lastScreenRefreshMs = millis();
    if (driverMuted) {
      drawMutedDashboard();
    } else if (isDangerMode || isWarnMode) {
      drawThreatDashboard();
    } else if (boundVehicleId.length() > 0) {
      drawNormalDashboard();
    } else {
      drawIdleDashboard();
    }
  }
}

void webSocketEvent(WStype_t type, uint8_t * payload, size_t length) {
  switch(type) {
    case WStype_DISCONNECTED:
      Serial.println("[WS] Disconnected!");
      break;
    case WStype_CONNECTED:
      Serial.println("[WS] Connected to Server");
      break;
    case WStype_TEXT: {
      String message = (char*)payload;
      
      // Parse JSON
      StaticJsonDocument<1024> doc;
      DeserializationError error = deserializeJson(doc, message);
      if (error) return;

      String msgType = doc["type"];
      if (msgType == "HARDWARE_BINDING_UPDATED") {
        if (doc["payload"]["vehicleId"].is<const char*>()) {
          boundVehicleId = String((const char*)doc["payload"]["vehicleId"]);
        } else {
          boundVehicleId = "";
        }
        driverMuted = false;
        isDangerMode = false;
        isWarnMode = false;
        lastMessage = boundVehicleId.length() > 0 ? "Bound to selected car" : "No vehicle selected";
        if (boundVehicleId.length() > 0) {
          drawNormalDashboard();
        } else {
          drawIdleDashboard();
        }
      } else if (msgType == "HARDWARE_DRIVER_ALERT") {
        String vehicleId = doc["payload"]["vehicleId"] | "";
        if (boundVehicleId.length() == 0 || vehicleId != boundVehicleId) {
          break;
        }
        String mode = doc["payload"]["mode"] | "SAFE";
        lastDistanceM = doc["payload"]["distanceM"].is<float>() ? doc["payload"]["distanceM"].as<float>() : -1.0f;
        lastTtiSeconds = doc["payload"]["ttiSeconds"].is<float>() ? doc["payload"]["ttiSeconds"].as<float>() : -1.0f;
        lastMessage = doc["payload"]["message"] | "";

        if (mode == "DANGER") {
          isDangerMode = true;
          isWarnMode = false;
          if (!driverMuted) drawThreatDashboard();
        } else if (mode == "WARN") {
          isWarnMode = true;
          isDangerMode = false;
          if (!driverMuted) drawThreatDashboard();
        } else {
          isDangerMode = false;
          isWarnMode = false;
          driverMuted = false; // clear mute when backend says road is safe again
          digitalWrite(SPEAKER_PIN, LOW);
          drawNormalDashboard();
        }
      }
      break;
    }
  }
}

void sendHardwareAcknowledge() {
  StaticJsonDocument<256> doc;
  doc["type"] = "HARDWARE_ACKNOWLEDGE";
  doc["deviceId"] = DEVICE_ID;
  doc["vehicleId"] = boundVehicleId;
  String output;
  serializeJson(doc, output);
  webSocket.sendTXT(output);
}

void drawIdleDashboard() {
  display.clearDisplay();
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.println("V2X NODE ONLINE");
  display.println("Waiting binding...");
  display.println("Select a car in UI");
  display.println("to attach hardware");
  display.display();
}

void drawNormalDashboard() {
  display.clearDisplay();
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.println("SYSTEM: ONLINE");
  display.println("V2X LINKED CAR:");
  display.println(boundVehicleId);
  display.println("Status: Road clear");
  display.setTextSize(1);
  display.println("Button: mute alert");
  display.setTextSize(2);
  display.setCursor(0, 30);
  display.println("SAFE");
  display.display();
}

void drawThreatDashboard() {
  display.clearDisplay();
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.println(boundVehicleId);
  display.setTextSize(2);
  display.println(isDangerMode ? "DANGER" : "WARN");
  display.setTextSize(1);
  if (lastDistanceM >= 0) {
    display.print("Dist: ");
    display.print((int)lastDistanceM);
    display.println(" m");
  } else {
    display.println("Dist: --");
  }
  if (lastTtiSeconds >= 0) {
    display.print("TTI: ");
    display.print((int)lastTtiSeconds);
    display.println(" s");
  } else {
    display.println("TTI: --");
  }
  display.println("Press btn to mute");
  display.println(lastMessage);
  display.display();
}

void drawMutedDashboard() {
  display.clearDisplay();
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.println(boundVehicleId);
  display.setTextSize(2);
  display.println("MUTED");
  display.setTextSize(1);
  display.println("Alert acknowledged.");
  display.println("Waiting SAFE reset...");
  display.display();
}
