import { useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";

export function TerminalClipboard({ terminal }: { terminal: Terminal }) {
  const menuRef = useRef<HTMLDivElement>(null);
  const pasteRef = useRef<HTMLDivElement>(null);
  const [hasSelection, setHasSelection] = useState(false);
  const [copyError, setCopyError] = useState(false);

  async function copySelection() {
    const text = terminal.getSelection();
    if (!text) return;
    setCopyError(false);
    try {
      // Il copy nativo usa il listener di xterm e funziona anche senza Async Clipboard API.
      if (document.execCommand("copy")) return;
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        return;
      }
    } catch {
      // Il browser può bloccare l'accesso agli appunti.
    }
    setCopyError(true);
  }

  async function pasteFromClipboard() {
    menuRef.current?.hidePopover();
    terminal.focus();
    setCopyError(false);
    let text: string | undefined;
    try {
      text = await navigator.clipboard?.readText();
    } catch {
      // L'incolla nativo resta disponibile anche quando la lettura diretta è negata.
    }
    if (!terminal.element?.isConnected || document.activeElement !== terminal.textarea) return;
    if (text === undefined) {
      const panel = pasteRef.current;
      panel?.showPopover();
      panel?.querySelector("textarea")?.focus();
    } else if (text) {
      terminal.paste(text);
    }
  }

  useEffect(() => {
    const element = terminal.element;
    if (!element) return;

    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown" || event.isComposing || event.altKey || event.metaKey) return true;
      const key = event.key.toLowerCase();
      if (event.ctrlKey && event.shiftKey && key === "c") {
        event.preventDefault();
        if (!event.repeat) void copySelection();
        return false;
      }
      // Lascia a Chrome l'azione predefinita: xterm riceverà l'evento paste nativo.
      if ((event.ctrlKey && key === "v") || (!event.ctrlKey && event.shiftKey && key === "insert")) {
        return false;
      }
      return true;
    });

    function showMenu(event: MouseEvent) {
      const menu = menuRef.current;
      if (!menu) return;
      event.preventDefault();
      event.stopPropagation();
      terminal.focus();
      const selected = terminal.hasSelection();
      setHasSelection(selected);
      menu.showPopover();
      const { width, height } = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(0, Math.min(event.clientX, window.innerWidth - width))}px`;
      menu.style.top = `${Math.max(0, Math.min(event.clientY, window.innerHeight - height))}px`;
      menu.focus();
    }

    element.addEventListener("contextmenu", showMenu, true);
    return () => {
      element.removeEventListener("contextmenu", showMenu, true);
      terminal.attachCustomKeyEventHandler(() => true);
    };
  }, [terminal]);

  return (
    <>
      <div ref={menuRef} popover="auto" tabIndex={-1} className="terminal-context-menu" role="group" aria-label="Azioni terminale">
        <button type="button" disabled={!hasSelection} onClick={() => {
          menuRef.current?.hidePopover();
          terminal.focus();
          void copySelection();
        }}>Copia</button>
        <button type="button" onClick={() => void pasteFromClipboard()}>Incolla</button>
        <button type="button" onClick={() => {
          menuRef.current?.hidePopover();
          terminal.focus();
          terminal.selectAll();
        }}>Seleziona tutto</button>
      </div>
      <div ref={pasteRef} popover="auto" className="terminal-paste-panel" role="group" aria-label="Incolla nel terminale">
        <label htmlFor="terminal-clipboard-input">Incolla qui con Ctrl+V o con il menu del browser.</label>
        <textarea id="terminal-clipboard-input" rows={2} onPaste={(event) => {
          event.preventDefault();
          const text = event.clipboardData.getData("text/plain");
          if (!text) return;
          pasteRef.current?.hidePopover();
          terminal.focus();
          terminal.paste(text);
        }} />
        <button type="button" className="btn btn-outline-light btn-sm" onClick={() => {
          pasteRef.current?.hidePopover();
          terminal.focus();
        }}>Annulla</button>
      </div>
      {copyError && <div className="terminal-clipboard-status" role="status">Chrome ha bloccato la copia negli appunti.</div>}
    </>
  );
}
