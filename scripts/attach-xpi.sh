#!/usr/bin/env bash
# If AMO has approved $TAG's version, attach the signed .xpi to that GitHub
# release and publish it; otherwise leave the release as a draft.
# Needs TAG, AMO_JWT_ISSUER, AMO_JWT_SECRET, GH_TOKEN, and GITHUB_REPOSITORY.
set -euo pipefail
version="${TAG#v}"
status="$(node scripts/amo.cjs status "$version")"
echo "AMO status for $version: $status"
case "$status" in
  public)
    mkdir -p dist
    node scripts/amo.cjs download "$version" "dist/waveform-$version.xpi"
    gh release upload "$TAG" "dist/waveform-$version.xpi" --clobber --repo "$GITHUB_REPOSITORY"
    gh release edit "$TAG" --draft=false --latest --repo "$GITHUB_REPOSITORY"
    echo "::notice::Published $TAG with the signed XPI."
    ;;
  disabled)
    echo "::error::AMO rejected or disabled $version. Check the developer hub, then delete the draft release and the tag."
    exit 1
    ;;
  *)
    echo "::notice::$version is still awaiting AMO review; the release stays a draft."
    ;;
esac
