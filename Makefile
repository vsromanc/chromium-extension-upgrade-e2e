.PHONY: build e2e e2e-headed e2e-debug down clean

# Omarchy keeps users out of the root-equivalent docker group by default and
# reaches the daemon via sudo instead. Use sudo only for docker, so build
# outputs (dist/, keys/) stay owned by you. Falls back to a socket check off Omarchy.
DOCKER := $(shell if command -v omarchy-sudo-docker >/dev/null; then omarchy-sudo-docker && echo sudo --preserve-env=HEADLESS,TESTS,CHROMIUM_LOG; \
            elif [ ! -w /var/run/docker.sock ]; then echo sudo --preserve-env=HEADLESS,TESTS,CHROMIUM_LOG; fi) docker

build:
	node scripts/pack.mjs

e2e: build
	rm -rf artifacts && mkdir -p artifacts
	$(DOCKER) compose up --build --abort-on-container-exit --exit-code-from browser; \
	  code=$$?; $(DOCKER) compose down; exit $$code

e2e-headed:
	HEADLESS=0 $(MAKE) e2e

# Verbose Chromium extension/updater logging + artifacts/netlog.json
e2e-debug:
	CHROMIUM_LOG=1 $(MAKE) e2e

down:
	$(DOCKER) compose down

clean: down
	rm -rf build dist artifacts
