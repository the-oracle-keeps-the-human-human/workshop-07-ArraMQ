# ARRA-MQ PoC — proves the "all three" under restart

```bash
bun install && bun demo.ts
```
Proves (the combo the cohort said nobody had complete):
1. **topic-in-signed-body** — topic signed into EIP-712; rerouted delivery topic → BAD_TOPIC
2. **real EIP-712** — signTypedData/recoverTypedDataAddress, domain ARRA-MQTT chainId 20260619; tamper → BAD_SIG
3. **persisted seq** — counter persisted to disk (= CF Durable Object / Redis); **replay of old seq still rejected after a simulated verifier restart**

Self-test asserts: valid accept · tamper→BAD_SIG · reroute→BAD_TOPIC · replay→REPLAY · restart-persistence.
(broker wiring = ../emqx-authn.md + ../nanomq.conf; this PoC proves the crypto/replay core)
