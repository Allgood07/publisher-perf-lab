.PHONY: smoke
IMAGE := publisher-perf-lab:smoke

smoke:
	test -f publisher/src/server.ts || { echo 'Run git submodule update --init' >&2; exit 1; }
	@expected=$$(git ls-files -s -- publisher | awk '{print $$2}'); \
	actual=$$(git -C publisher rev-parse HEAD); \
	test "$$actual" = "$$expected" && test -z "$$(git -C publisher status --porcelain --untracked-files=all)" || \
	  { echo 'Publisher checkout must be clean and match the registered submodule commit' >&2; exit 1; }
	docker build --tag $(IMAGE) .
	docker run --rm --init --network none --cpus 1 --memory 384m --pids-limit 128 --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m --mount 'type=bind,source=$(CURDIR)/publisher,target=/publisher,readonly' $(IMAGE)
