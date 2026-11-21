import { useRef } from "react";

const ACCEPT = ".pdf,.epub,application/pdf,application/epub+zip";

/** Keyboard-accessible upload entry point; drag and drop works on the page. */
export function AddBookButton({ onUpload, busy }: { onUpload: (file: File) => void; busy: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className="ghost bordered add-book" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? "Adding…" : "Add book"}
      </button>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        hidden
        disabled={busy}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onUpload(file);
          event.target.value = "";
        }}
      />
    </>
  );
}
