#!/usr/bin/env bash
set -eEuo pipefail

workdir="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." &> /dev/null && pwd )"
github_tag="${GITHUB_REF_NAME:-}"
repo_slug="${GITHUB_REPOSITORY:-}"
github_token="${GITHUB_TOKEN:-}"

export COMMON_FILE_LOCATION='ci/common.sh'
if ! [ -f "${workdir}/${COMMON_FILE_LOCATION}" ]; then
  echo "ERROR: ${COMMON_FILE_LOCATION} file is missing. Please make sure the file exists in the correct location."
  exit 1
else
  # shellcheck disable=SC1090
  source "${workdir}/${COMMON_FILE_LOCATION}"
fi

# Check requirements
if [ -z "${github_tag}" ]; then
  fn_die "GITHUB_REF_NAME is not set. This script is intended to be run in GitHub Actions CI/CD environment."
fi

if [ -z "${repo_slug}" ]; then
  fn_die "GITHUB_REPOSITORY is not set. This script is intended to be run in GitHub Actions CI/CD environment."
fi

if [ -z "${github_token}" ]; then
  fn_die "GITHUB_TOKEN is not set. Please ensure the release job has 'contents: write' permission."
fi

log_info "=== Generating GitHub Release ${github_tag} for ${repo_slug} ==="
curl -s --fail-with-body -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: token ${github_token}" \
  "https://api.github.com/repos/${repo_slug}/releases" \
  -d "{\"tag_name\":\"${github_tag}\",\"generate_release_notes\":true}"

exit 0
