# cline2api-workers — deploy both targets, refresh token, test.
#
# Usage:
#   make deploy TOKENS_FILE=/tmp/tokens.txt CF_URL=https://xxx.workers.dev VERCEL_URL=https://xxx.vercel.app
#   make deploy-cf / deploy-vercel   (one target only)
#   make test                         (stubbed script test, no real deploy)
#   make check                        (syntax check only)
#
# Vars can also come from env: TOKENS_FILE, CF_URL, VERCEL_URL, API_KEY.
# Or from a gitignored .env file (KEY=value per line); `make VAR=x` still wins.
-include .env
export

TOKENS_FILE ?=
CF_URL ?=
VERCEL_URL ?=
API_KEY ?=

DEPLOY := scripts/deploy.sh
TEST := tests/test_deploy.sh

.PHONY: help deploy deploy-cf deploy-vercel test check

help:
	@echo "Targets: deploy deploy-cf deploy-vercel test check"
	@echo "Vars: TOKENS_FILE CF_URL VERCEL_URL API_KEY"

deploy:
	$(DEPLOY) --tokens-file "$(TOKENS_FILE)" --cf-url "$(CF_URL)" --vercel-url "$(VERCEL_URL)"

deploy-cf:
	$(DEPLOY) --tokens-file "$(TOKENS_FILE)" --cf-url "$(CF_URL)" --vercel-url "$(VERCEL_URL)" --skip-vercel

deploy-vercel:
	$(DEPLOY) --tokens-file "$(TOKENS_FILE)" --cf-url "$(CF_URL)" --vercel-url "$(VERCEL_URL)" --skip-cf

test:
	bash $(TEST)

check:
	bash -n $(DEPLOY)
	bash -n $(TEST)
