int enA = 9;
int in1 = 8;
int in2 = 7;
int enB = 3;
int in3 = 4;
int in4 = 2;
int trigPin = 11;
int echoPin = 12;
bool solanaTriggered = false;

void setup() {
  Serial.begin(9600);
  pinMode(enA, OUTPUT);
  pinMode(in1, OUTPUT);
  pinMode(in2, OUTPUT);
  pinMode(enB, OUTPUT);
  pinMode(in3, OUTPUT);
  pinMode(in4, OUTPUT);
  pinMode(trigPin, OUTPUT);
  pinMode(echoPin, INPUT);
  pinMode(13, OUTPUT);
  
  digitalWrite(13, LOW);
  Serial.println("ARDUINO_READY");
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
  digitalWrite(in1, i1);
  digitalWrite(in2, i2);
  digitalWrite(in3, i3);
  digitalWrite(in4, i4);
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
    if (data == 'S') { // Added stop command
      solanaTriggered = false;
      digitalWrite(13, LOW);
    }
  }

  if (solanaTriggered) {
    long distance = getSmoothDistance();
    
    // Dashboard feedback: ts,angle,lpwm,rpwm,dist
    Serial.print(millis());
    Serial.print(",0,200,200,");
    Serial.println(distance);

    if (distance < 30 && distance > 0) {
      // OBSTACLE DETECTED
      move(0, 0, LOW, LOW, LOW, LOW); // Stop briefly
      delay(200);
      
      // REVERSE SLIGHTLY
      move(150, 150, HIGH, LOW, HIGH, LOW); 
      delay(400);

      // TURN RIGHT (Right motor BACK, Left motor FORWARD)
      // If this turns left, swap the HIGH/LOW on one motor
      move(180, 180, HIGH, LOW, LOW, HIGH); 
      delay(400); 
    } else {
      // FORWARD (Both motors FORWARD)
      // Check if both motors spin same way. If not, swap LOW/HIGH on the bad side.
      move(200, 200, LOW, HIGH, LOW, HIGH); 
    }
  } else {
    move(0, 0, LOW, LOW, LOW, LOW);
  }
  delay(30);
}