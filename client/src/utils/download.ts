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
  window.URL.revokeObjectURL(url);
}