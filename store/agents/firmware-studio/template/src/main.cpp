#include <Arduino.h>

// Example LED assignment, not a verified board pinout. Confirm GPIO 2 on your board.
const int kLed = 2;

void setup() {
  pinMode(kLed, OUTPUT);
  Serial.begin(115200);
  delay(200);
  Serial.println("firmware alive");
}

void loop() {
  digitalWrite(kLed, HIGH);
  delay(500);
  digitalWrite(kLed, LOW);
  delay(500);
}
