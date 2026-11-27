#!/usr/bin/env bash
# Manual, local filesystem operation. Stop the consuming service before use.
set -Eeuo pipefail

if [[ $# != 3 ]]; then
  printf 'Uso: %s DIRECTORY_APP DIRECTORY_IN_INGRESSO DIRECTORY_BACKUP_VUOTA\n' "$0" >&2
  exit 2
fi

app=$(realpath -e -- "$1")
incoming=$(realpath -e -- "$2")
backup=$(realpath -e -- "$3")
directories=("$app" "$incoming" "$backup")
device=$(stat -c %d -- "$app")
for dir in "${directories[@]}"; do
  [[ -d "$dir" && "$dir" != / && -w "$dir" && $(stat -c %d -- "$dir") == "$device" ]] || exit 2
  for peer in "${directories[@]}"; do
    if [[ "$dir" != "$peer" && "$dir/" == "$peer/"* ]]; then
      printf 'Le directory devono essere separate.\n' >&2
      exit 2
    fi
  done
done
[[ "$app" != "$incoming" && "$app" != "$backup" && "$incoming" != "$backup" ]] || exit 2
[[ -z $(find "$backup" -mindepth 1 -maxdepth 1 -print -quit) ]] || {
  printf 'La directory di backup deve essere vuota.\n' >&2
  exit 2
}

runtime=(dist node_modules package.json package-lock.json)
for entry in "${runtime[@]}"; do
  for dir in "$app" "$incoming"; do
    if [[ ! -e "$dir/$entry" || -L "$dir/$entry" ]]; then
      printf 'Runtime incompleto o collegamento simbolico al primo livello: %s/%s\n' "$dir" "$entry" >&2
      exit 2
    fi
  done
done
for dir in "$app" "$incoming"; do
  [[ -f "$dir/dist/backend/server.js" && -f "$dir/dist/frontend/index.html" && -d "$dir/node_modules" ]] || {
    printf 'Gli artefatti attesi sono assenti in %s.\n' "$dir" >&2
    exit 2
  }
done

restore_on_error() {
  local code="$1" entry
  trap - ERR INT TERM
  for entry in "${runtime[@]}"; do
    [[ -e "$backup/$entry" ]] || continue
    if [[ -e "$app/$entry" ]]; then
      mv -T -- "$app/$entry" "$incoming/$entry" || exit 3
    fi
    mv -T -- "$backup/$entry" "$app/$entry" || exit 3
  done
  exit "$code"
}
trap 'restore_on_error "$?"' ERR
trap 'restore_on_error 130' INT
trap 'restore_on_error 143' TERM

for entry in "${runtime[@]}"; do
  mv -T -- "$app/$entry" "$backup/$entry"
  mv -T -- "$incoming/$entry" "$app/$entry"
done
trap - ERR INT TERM
printf 'Runtime scambiato. Backup precedente in %s\n' "$backup"
