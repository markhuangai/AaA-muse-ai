#!/usr/bin/env bash
set +x
set -euo pipefail
umask 077

target=$1
observed=unavailable
refuse() {
  printf '%s %s\n' "$1" "$observed"
  exit 1
}

inspect() {
  local snapshot
  snapshot=$(stat -c '%d:%i %a %u' -- "$1") || refuse directory_stat_failed
  read -r identity mode uid <<< "$snapshot"
  observed="mode_${mode}_uid_${uid}"
}

[[ "$target" == /* ]] || refuse absolute_directory_required
named_identity=''
if [[ -e "$target" || -L "$target" ]]; then
  inspect "$target"
  named_identity=$identity
  [[ ! -L "$target" && -d "$target" ]] || refuse wrong_directory_type
fi
physical=$(realpath -m -- "$target") || refuse directory_stat_failed
lexical=$(realpath -ms -- "$target") || refuse directory_stat_failed
[[ "$physical" == "$lexical" ]] || refuse directory_path_link
if [[ -z "$named_identity" ]]; then
  mkdir -p -m 00700 -- "$target" || refuse directory_creation_failed
  inspect "$target"
  named_identity=$identity
fi
[[ ! -L "$target" && -d "$target" ]] || refuse wrong_directory_type
[[ "$uid" == "$EUID" ]] || refuse wrong_directory_owner

# The physical working directory pins the inode used for inspection and chmod.
cd -P -- "$target" || refuse directory_open_failed
verify_binding() {
  [[ $(pwd -P) == "$lexical" && $(stat -c '%d:%i' -- "$target") == "$named_identity" ]] || refuse directory_identity_changed
}
inspect .
[[ "$identity" == "$named_identity" ]] || refuse directory_identity_changed
verify_binding
[[ "$uid" == "$EUID" ]] || refuse wrong_directory_owner
case "$mode" in
  700) ;;
  2700)
    entry=$(find . -mindepth 1 -maxdepth 1 -printf x -quit) || refuse directory_inspection_failed
    [[ -z "$entry" ]] || refuse directory_not_empty
    verify_binding
    chmod g-s -- . || refuse directory_chmod_failed
    ;;
  *) refuse unsafe_directory_mode ;;
esac
inspect .
[[ "$mode" == 700 && "$uid" == "$EUID" ]] || refuse unsafe_private_directory
verify_binding
