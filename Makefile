# node:test strips TypeScript at runtime, so the app/tests need no install;
# typecheck uses the dev dependencies.
.PHONY: install test typecheck check start

install:    ## install dev dependencies (for typecheck)
	npm ci

test:       ## run the suite (node:test, no services)
	npm test

typecheck:  ## strict typecheck
	npm run typecheck

check: typecheck test   ## what CI runs

start:      ## run the webhook server locally on :3000 with the in-memory fakes
	WEBHOOK_SECRET=dev_only npm start
