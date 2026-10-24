#!/bin/sh
set -eu

find /emulatorjs/data/cores -type f \( -name '*.data' -o -path '*/reports/*.json' \) > /tmp/core-files
while IFS= read -r file; do
    relative="${file#/emulatorjs/data/cores/}"
    if [ ! -f "/custom-cores/$relative" ]; then
        printf '%s\0' "$file"
    fi
done < /tmp/core-files | xargs -0 -r -n 1 -P 4 sh -eu -c '
    file="$1"
    relative="${file#/emulatorjs/data/}"
    echo "Downloading $relative"
    curl -fsSL --connect-timeout 20 --max-time 600 --retry 3 \
        -o "${file}.download" "https://cdn.emulatorjs.org/nightly/data/${relative}"
    mv "${file}.download" "$file"
' sh
