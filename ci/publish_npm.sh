#!/usr/bin/env bash
set -eEuo pipefail

workdir="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." &> /dev/null && pwd )"
github_tag="${GITHUB_REF_NAME:-}"
prod_release="${PROD_RELEASE:-false}"
is_a_release="${IS_A_RELEASE:-false}"

export COMMON_FILE_LOCATION='ci/common.sh'
if ! [ -f "${workdir}/${COMMON_FILE_LOCATION}" ]; then
  echo "ERROR: ${COMMON_FILE_LOCATION} file is missing. Please make sure the file exists in the correct location."
  exit 1
else
  # shellcheck disable=SC1090
  source "${workdir}/${COMMON_FILE_LOCATION}"
fi

# Check requirements
if [ "${is_a_release}" = "false" ]; then
  log_warn "Not a release build — skipping publish."
  exit 0
fi

if [ -z "${github_tag}" ]; then
  fn_die "GITHUB_REF_NAME is not set. This script is intended to be run in GitHub Actions CI/CD environment."
fi

# Install dependencies
log_info "Installing dependencies..."
pnpm install --frozen-lockfile --ignore-scripts || fn_die "Failed to install dependencies."

# Build the workspace package
log_info "Building @horizen/x402-private-vela-fixed..."
pnpm --filter @horizen/x402-private-vela-fixed build || fn_die "Failed to build the package."

# Publish the package to NPM registry
if [ "${prod_release}" = "true" ]; then

  # Authentication is via OIDC trusted publishing (id-token: write + a trusted
  # publisher configured on npmjs.org) — no NPM_TOKEN/.npmrc credential needed.
  log_info "Publishing to npm registry via OIDC trusted publishing..."
  cd "${workdir}/packages/x402-private-vela-fixed"
  npm publish --access public --provenance --ignore-scripts || fn_die "Failed to publish the package to npm registry."

  log_info "Package successfully published to the npm registry under version: ${github_tag}"
else
  log_warn "This is not a 'PRODUCTION' release build. NPM package will not be published."
fi
