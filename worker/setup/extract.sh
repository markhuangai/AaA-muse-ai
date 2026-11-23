#!/usr/bin/env bash
set -euo pipefail
umask 077
archive=$1
bundle=$2
entries=$(tar --quoting-style=escape -tzf "$archive")
types=$(tar --quoting-style=escape -tvzf "$archive")
while IFS= read -r entry; do
  [[ "$entry" =~ ^package/[A-Za-z0-9_./-]+$ && "$entry" != *'//'* && "$entry" != *'/../'* && "$entry" != *'/./'* && "$entry" != *'/..' && "$entry" != *'/.' ]]
  case "$entry" in package/dist/*|package/setup/*|package/package.json|package/LICENSE|package/README.md) ;; *) exit 1 ;; esac
done <<< "$entries"
while IFS= read -r entry; do
  [[ ${entry:0:1} == - || ${entry:0:1} == d ]]
done <<< "$types"
tar -xzf "$archive" --no-same-owner --no-same-permissions -C "$bundle"
