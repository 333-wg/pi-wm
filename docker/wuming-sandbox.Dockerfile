# syntax=docker/dockerfile:1
#
# The exec / run_python sandbox image.
#
# Wuming runs every command in a fresh container from this image: no capabilities,
# no new privileges, a read-only root filesystem, and (by default) no network. The
# only writable places are the workspace bind mount, /tmp, and $HOME — so the
# toolchain has to be baked in here rather than installed at run time.
#
# Build and pin it by digest, because the gateway rejects a mutable reference:
#
#   docker build -f docker/wuming-sandbox.Dockerfile -t wuming-runner:local .
#   docker image inspect wuming-runner:local --format '{{index .RepoDigests 0}}'
#
# A locally built image has no RepoDigests until it is pushed. Either push it to a
# registry and use that digest, or set WUMING_DOCKER_ALLOW_MUTABLE_IMAGE=true and
# WUMING_DOCKER_IMAGE=wuming-runner:local for local development only.
FROM node:22.12.0-bookworm-slim

# git for inspection (status, diff, log), python3 for run_python, build-essential
# for packages with native addons. Nothing here needs to be installed at run time.
RUN apt-get update \
	&& apt-get install --yes --no-install-recommends \
		build-essential \
		ca-certificates \
		git \
		python3 \
		python3-pip \
		python3-venv \
	&& rm -rf /var/lib/apt/lists/*

# The gateway passes --user matching its own uid so that files the model creates in
# the workspace stay editable on the host. That uid has no /etc/passwd entry, which
# would otherwise make git refuse the bind-mounted repository as "dubious
# ownership"; this config is read from the environment, so no writable
# global gitconfig is needed.
ENV GIT_CONFIG_COUNT=1 \
	GIT_CONFIG_KEY_0=safe.directory \
	GIT_CONFIG_VALUE_0=/workspace \
	PIP_DISABLE_PIP_VERSION_CHECK=1 \
	PIP_NO_CACHE_DIR=off \
	PYTHONDONTWRITEBYTECODE=1

WORKDIR /workspace
CMD ["/bin/sh", "-lc", "node --version && python3 --version && git --version"]
