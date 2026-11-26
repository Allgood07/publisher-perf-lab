TARGETS := smoke measure-read measure-publish measure-probe-10 measure-probe-25 measure-probe-50 measure-read-50 measure-publish-50
CAPACITY_RATES := 50 100 150 200 250 300 350 400 450 500 550 600 650 700 750 800 900 1000 1100 1200 1400 1600
CAPACITY_TARGETS := $(foreach phase,scan capacity soak,$(foreach workload,read publish,$(addprefix $(phase)-$(workload)-,$(CAPACITY_RATES))))
.PHONY: $(TARGETS) $(CAPACITY_TARGETS)
IMAGE := publisher-perf-lab:smoke

$(TARGETS) $(CAPACITY_TARGETS):
	test -f publisher/src/server.ts || { echo 'Run git submodule update --init' >&2; exit 1; }
	@expected=$$(git ls-files -s -- publisher | awk '{print $$2}'); \
	actual=$$(git -C publisher rev-parse HEAD); \
	test "$$actual" = "$$expected" && test -z "$$(git -C publisher status --porcelain --untracked-files=all)" || \
	  { echo 'Publisher checkout must be clean and match the registered submodule commit' >&2; exit 1; }
	docker build --tag $(IMAGE) .
	docker run --rm --init --network none --cpus 1 --memory 384m --pids-limit 128 --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m --mount 'type=bind,source=$(CURDIR)/publisher,target=/publisher,readonly' $(IMAGE) $(patsubst measure-%,%,$@)
