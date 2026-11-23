# node:test strips TypeScript at runtime, so the memory-path tests need no install;
# typecheck and the Postgres tests (DATABASE_URL set) need `make install`.
.PHONY: install test typecheck check start

install:    ## install dev dependencies (for typecheck)
	npm ci

test:       ## run the suite; the Postgres tests run only with DATABASE_URL set
	npm test

typecheck:  ## strict typecheck
	npm run typecheck

check: typecheck test   ## what CI runs (CI also sets DATABASE_URL and REQUIRE_POSTGRES=1)

start:      ## run the webhook server locally on :3000 with the in-memory fakes
	WEBHOOK_SECRET=dev_only npm start
