// A confirm dialog that crumples into a paper ball when you confirm.
// Load modern-screenshot and crumple.js once (script tags or your bundler), then:
//
//   <CrumpleConfirm title="Delete this file?" confirmLabel="Delete" onConfirm={remove} onCancel={close} />

import { useEffect, useRef, useState } from "react";
import type { Crumple, CrumpleBall } from "../../crumple";

type Props = {
  title: string;
  text?: string;
  confirmLabel?: string;
  onConfirm: (ball: CrumpleBall) => void;
  onCancel: () => void;
};

export function CrumpleConfirm({ title, text, confirmLabel = "Delete", onConfirm, onCancel }: Props) {
  const dialog = useRef<HTMLDivElement>(null);
  const toss = useRef<Crumple | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = window.Crumple.create();
    toss.current = t;
    const off = t.on("score", (ball) => onConfirm(ball));
    // capture after the dialog has painted, so the swap to WebGL is invisible
    const id = requestAnimationFrame(() => dialog.current && t.prepare(dialog.current));
    return () => { cancelAnimationFrame(id); off(); t.destroy(); };
  }, [onConfirm]);

  return (
    <div ref={dialog} role="alertdialog" aria-modal="true" className="dialog">
      <h2>{title}</h2>
      {text && <p>{text}</p>}
      <div className="actions">
        <button onClick={onCancel} disabled={busy}>Cancel</button>
        <button
          className="danger"
          style={{ touchAction: "none" }}
          onPointerDown={(e) => {
            if (busy || !dialog.current || !toss.current) return;
            e.preventDefault();
            setBusy(true);
            toss.current.grab(dialog.current, e.nativeEvent);
          }}
          onClick={(e) => {
            // keyboard: Enter or Space makes a perfect shot
            if (e.detail !== 0 || busy || !dialog.current || !toss.current) return;
            setBusy(true);
            toss.current.throwInto(dialog.current);
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}
