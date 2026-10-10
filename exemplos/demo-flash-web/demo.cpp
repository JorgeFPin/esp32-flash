#include <Arduino.h>


#define DEMO_VERSAO "1.0.0"

#if CONFIG_IDF_TARGET_ESP32S3
  // ESP32-S3-DevKitC: LED RGB endereçável no GPIO48 (nalgumas placas é o GPIO38).
  #ifndef RGB_BUILTIN
    #define RGB_BUILTIN 48
  #endif
  #define USA_RGB 1
#else
  // ESP32 DevKit: LED azul no GPIO2.
  #define LED_PIN 2
  #define USA_RGB 0
#endif

void ledOn(bool on) {
#if USA_RGB
  rgbLedWrite(RGB_BUILTIN, 0, on ? 40 : 0, on ? 40 : 0);
#else
  digitalWrite(LED_PIN, on ? HIGH : LOW);
#endif
}

void setup() {
  Serial.begin(115200);
  delay(300);
#if !USA_RGB
  pinMode(LED_PIN, OUTPUT);
#endif
  Serial.println();
  Serial.println("========================================");
  Serial.println(" ESP32 Flash via WEB - by Jorge Pinheiro");
  Serial.println(" Firmware de demonstracao v" DEMO_VERSAO);
  Serial.println("========================================");
  Serial.printf(" Chip: %s rev %d, %d nucleo(s)\n", ESP.getChipModel(), ESP.getChipRevision(), ESP.getChipCores());
  Serial.printf(" Flash: %u MB\n", ESP.getFlashChipSize() / (1024 * 1024));
  Serial.printf(" MAC: %012llX\n", ESP.getEfuseMac());
  Serial.println(" Gravacao concluida com sucesso!");
  Serial.println();
}

void loop() {
  static uint32_t n = 0;
  ledOn(true);
  delay(150);
  ledOn(false);
  delay(850);
  if (++n % 5 == 0) {
    Serial.printf("[%lus] a funcionar - demo v" DEMO_VERSAO "\n", millis() / 1000);
  }
}
