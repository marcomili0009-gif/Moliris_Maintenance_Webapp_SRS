// Requisiti soddisfatti: SRS §3.5, §3.6, RNF-UX-001

/**
 * Scarica un Blob sul client tramite un anchor <a> transiente.
 * Il DOM viene toccato solo in questo punto, isolato da un helper di sola utilità,
 * e ogni riferimento viene rilasciato nel finally per evitare perdite di memoria.
 */
export function triggerDownload(blob: Blob, fileName: string): void {
  const url = window.URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // La revoca immediata può interrompere il download: lasciare al browser
  // il tempo di aprire il blob prima di rilasciarlo.
  window.setTimeout(() => window.URL.revokeObjectURL(url), 60_000);
}

/**
 * Avvia un download lasciando che sia il browser a ricevere il flusso
 * direttamente dal backend. Non usa Blob/fetch: un file da 3 GB non viene
 * mai interamente caricato in RAM nel browser (RF-TRF-004, RNF-PERF-001).
 */
export function triggerStreamingDownload(url: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}