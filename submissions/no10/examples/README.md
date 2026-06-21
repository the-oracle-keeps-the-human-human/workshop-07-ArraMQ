# ARRA-MQ Examples

This directory contains a TypeScript reference implementation for signing MQTT payloads locally at the publisher client using EIP-191 and verifying them statelessly at the subscriber.

## Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Start a local MQTT Broker** (e.g. Eclipse Mosquitto):
   ```bash
   docker run -d --name mosquitto -p 1883:1883 eclipse-mosquitto
   ```
   *(Ensure anonymous connections are allowed, or configure credentials and pass the connection URL via the `MQTT_URL` environment variable).*

## Run Examples

1. **Start the subscriber (Verifier)**:
   ```bash
   npm run subscriber
   ```

2. **Start the publisher (Client)**:
   ```bash
   npm run publisher
   ```

The publisher will generate a test wallet address, construct the EIP-191 payload message, sign it, and publish to the `sensor/no10/temperature` topic. The subscriber will receive, verify the timestamp drift (skew within ±30s), check topic integrity, verify the signature, and output the validation status.
