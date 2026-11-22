#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
FQBN="esp32:esp32:esp32"

if ! command -v arduino-cli >/dev/null 2>&1; then
  echo "No encuentro arduino-cli. Instala Arduino CLI y vuelve a ejecutar este script." >&2
  exit 1
fi

if ! arduino-cli core list | awk '$1 == "esp32:esp32" { found = 1 } END { exit !found }'; then
  echo "Falta el núcleo ESP32. Instálalo con: arduino-cli core install esp32:esp32" >&2
  exit 1
fi

read -r -p "Ruta del archivo cloud_config.h de Primaria: " CONFIG_FILE
CONFIG_FILE="${CONFIG_FILE/#\~/$HOME}"
CONFIG_FILE="${CONFIG_FILE#\"}"
CONFIG_FILE="${CONFIG_FILE%\"}"
CONFIG_FILE="${CONFIG_FILE#\'}"
CONFIG_FILE="${CONFIG_FILE%\'}"

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "No existe ese archivo: $CONFIG_FILE" >&2
  exit 1
fi

if ! grep -Eq '^[[:space:]]*#define[[:space:]]+TIMBRE_CLOUD_URL[[:space:]]+"https://[^"[:space:]]+"' "$CONFIG_FILE"; then
  echo "El archivo no contiene una TIMBRE_CLOUD_URL HTTPS válida." >&2
  exit 1
fi

if ! grep -Eq '^[[:space:]]*#define[[:space:]]+TIMBRE_DEVICE_TOKEN[[:space:]]+"[[:xdigit:]]{64}"[[:space:]]*$' "$CONFIG_FILE"; then
  echo "El token debe tener 64 caracteres hexadecimales. No uses un token de GitHub." >&2
  exit 1
fi

echo
echo "Puertos detectados:"
arduino-cli board list
read -r -p "Puerto de la ESP32 [/dev/ttyUSB0]: " PORT
PORT="${PORT:-/dev/ttyUSB0}"

if [[ ! -e "$PORT" ]]; then
  echo "No existe el puerto $PORT. Conecta la placa y revisa 'arduino-cli board list'." >&2
  exit 1
fi

for FILE in trabajo-timbre.ino cloud_protocol.h cloud_ca.h; do
  if [[ ! -f "$ROOT_DIR/$FILE" ]]; then
    echo "Falta $ROOT_DIR/$FILE" >&2
    exit 1
  fi
done

TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/timbre-firmware.XXXXXX")"
trap 'rm -rf "$TEMP_DIR"' EXIT
SKETCH_DIR="$TEMP_DIR/trabajo-timbre"
mkdir -m 700 "$SKETCH_DIR"
cp "$ROOT_DIR/trabajo-timbre.ino" "$ROOT_DIR/cloud_protocol.h" "$ROOT_DIR/cloud_ca.h" "$SKETCH_DIR/"
install -m 600 "$CONFIG_FILE" "$SKETCH_DIR/cloud_config.h"

echo
echo "Compilando y cargando en $PORT..."
arduino-cli compile --fqbn "$FQBN" --port "$PORT" --upload "$SKETCH_DIR"
echo "Firmware cargado correctamente."
