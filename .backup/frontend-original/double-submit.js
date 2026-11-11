// Requisiti soddisfatti: RNF-UX-002, Step 4

/**
 * Gestione dello stato di attesa e blocco del doppio invio (Double Submit Guard).
 * Previene registrazioni duplicate, doppi avvii di trasferimenti o aggiornamenti multipli concorrenti.
 */
export class DoubleSubmitGuard {
  /**
   * Esegue un'azione asincrona disabilitando temporaneamente il pulsante specificato
   * e mostrando un indicatore testuale di attesa fino al completamento.
   */
  static async execute(buttonElement, pendingText, actionFn) {
    if (!buttonElement) {
      return await actionFn();
    }

    if (buttonElement.disabled || buttonElement.dataset.pending === "true") {
      return; // Ignora click multipli durante l'elaborazione
    }

    const originalText = buttonElement.innerHTML;
    buttonElement.disabled = true;
    buttonElement.dataset.pending = "true";
    if (pendingText) {
      buttonElement.innerHTML = `<span class="spinner-inline">⏳</span> ${pendingText}`;
    }

    try {
      return await actionFn();
    } finally {
      buttonElement.disabled = false;
      delete buttonElement.dataset.pending;
      buttonElement.innerHTML = originalText;
    }
  }

  /**
   * Helper per legare un pulsante a un'azione con blocco del doppio invio.
   */
  static bind(buttonElement, pendingText, actionFn) {
    if (!buttonElement) return;
    buttonElement.addEventListener("click", async (e) => {
      e.preventDefault();
      await this.execute(buttonElement, pendingText, actionFn);
    });
  }
}
