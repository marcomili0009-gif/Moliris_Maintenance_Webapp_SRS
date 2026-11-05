#!/usr/bin/env bash
# ==============================================================================
# Script di Bonifica Globale File Temporanei Orfani (Moliris Maintenance Webapp)
# Riferimenti SRS: RF-TRF-009, CA-TRF-005, RNF-FS-003, RNF-REL-005
# ==============================================================================
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

echo "Avvio bonifica definitiva file temporanei (.tmp_moliris_*) dal Server e dai Robot..."
npx tsx scripts/purge-all-temp-files.ts "$@"
