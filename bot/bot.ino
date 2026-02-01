#include <EEPROM.h>

int enA = 9;
int in1 = 8;
int in2 = 7;
int enB = 3;
int in3 = 4;
int in4 = 2;
int trigPin = 11;
int echoPin = 12;

bool solanaTriggered = false;
unsigned long lastLogTime = 0;
int lastSavedDistance = 0;

void setup() {
  Serial.begin(9600);
  pinMode(enA, OUTPUT); pinMode(in1, OUTPUT); pinMode(in2, OUTPUT);
  pinMode(enB, OUTPUT); pinMode(in3, OUTPUT); pinMode(in4, OUTPUT);
  pinMode(trigPin, OUTPUT); pinMode(echoPin, INPUT);
  pinMode(13, OUTPUT);
  
  digitalWrite(13, LOW);
}

long getSmoothDistance() {
  digitalWrite(trigPin, LOW);
  delayMicroseconds(2);
  digitalWrite(trigPin, HIGH);
  delayMicroseconds(10);
  digitalWrite(trigPin, LOW);
  long d = pulseIn(echoPin, HIGH, 20000);
  if (d <= 0) return 200;
  return d * 0.034 / 2;
}

void move(int sRight, int sLeft, int i1, int i2, int i3, int i4) {
  digitalWrite(in1, i1); digitalWrite(in2, i2);
  digitalWrite(in3, i3); digitalWrite(in4, i4);
  analogWrite(enA, constrain(sRight, 0, 255));
  analogWrite(enB, constrain(sLeft, 0, 255));
}

void loop() {
  if (Serial.available() > 0) {
    char data = Serial.read();
    if (data == 'F') {
      solanaTriggered = true;
      digitalWrite(13, HIGH);
      delay(2000); 
    }
    if (data == 'S') {
      solanaTriggered = false;
      digitalWrite(13, LOW);
    }
    // NEW: Request data when plugged back in
    if (data == 'D') {
      int val = 0;
      EEPROM.get(0, val);
      Serial.print("LAST_DISTANCE_LOGGED: ");
      Serial.println(val);
    }
  }

  if (solanaTriggered) {
    long distance = getSmoothDistance();
    
    // Save to memory every 1 second
    if (millis() - lastLogTime >= 1000) {
      lastSavedDistance = (int)distance;
      EEPROM.put(0, lastSavedDistance); 
      lastLogTime = millis();
    }

    if (distance < 30 && distance > 0) {
      move(0, 0, LOW, LOW, LOW, LOW);
      delay(200);
      move(155, 150, HIGH, LOW, HIGH, LOW); 
      delay(400);
      move(185, 180, HIGH, LOW, LOW, HIGH); 
      delay(400); 
    } else {
      move(250, 200, LOW, HIGH, LOW, HIGH); 
    }
  } else {
    move(0, 0, LOW, LOW, LOW, LOW);
  }
  delay(30);
}