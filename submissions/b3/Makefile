# ───────────────────────────────────────────────────────────────────────────
# ArraMQ — SIWE/EIP-712 authenticated MQTT (Workshop-07, B3 Oracle)
# Run `make` for the ordered steps.
# ───────────────────────────────────────────────────────────────────────────
SHELL := /bin/bash
export ARRAMQ_JWT_SECRET ?= dev-only-change-me
export CHAIN_ID          ?= 20260619
.DEFAULT_GOAL := help

deps: ## 1. pull/build images (EMQX + auth-svc), need docker + node
	docker compose build
	docker pull emqx/emqx:5.8
	@echo "✅ deps"

up: ## 2. start EMQX broker + auth-svc
	docker compose up -d
	@echo "✅ up — dashboard :18083, MQTT :1883, auth-svc :3000"

health: ## 3. check auth-svc + broker are live
	@curl -fsS http://localhost:3000/health && echo " auth-svc ✅"
	@docker exec arramq-emqx emqx ctl status | head -1

demo: ## 4. run client: sign EIP-712 -> token -> connect -> pub/sub own topic
	cd client && npm install --silent && node connect.js

demo-msg: ## 4b. per-message E2E: start verifier (persisted seq) then publish signed msgs
	cd verifier && npm install --silent
	cd client && npm install --silent
	@echo "run in two shells:"
	@echo "  REDIS_URL=redis://localhost:6379 node verifier/subscriber.js   # ✓ VALID / ✗ REJECT REPLAY_SEQ"
	@echo "  node client/publish-signed.js                                  # signs Msg{from,topic,ts,seq,dataHash}"

acl-test: ## 5. prove deny: subscribing to a FOREIGN topic must be rejected (see client log "denied foreign topic ✅")
	@echo "watch the client log: own topic subscribes ✅, arra/<other>/# is denied ✅"

expiry-test: ## 6. prove expiry: a token past exp is rejected by EMQX on (re)connect
	@echo "set TOKEN_TTL low in auth-svc, reconnect → broker rejects expired JWT"

down: ## teardown (no data loss)
	docker compose down
	@echo "✅ down"

help: ## list ordered steps
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | sed -E 's/:.*## /\t/' | awk -F'\t' '{printf "  make %-12s %s\n",$$1,$$2}'

.PHONY: deps up health demo acl-test expiry-test down help
