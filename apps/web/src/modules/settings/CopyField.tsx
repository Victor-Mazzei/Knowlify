import { useState, type ReactNode } from "react";

export function CopyField({
  label,
  value,
  action,
}: {
  label: string;
  value: string;
  /** Optional inline action shown next to the copied value. */
  action?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const input = document.createElement("input");
      input.value = value;
      document.body.append(input);
      input.select();
      document.execCommand("copy");
      input.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }
  return (
    <div className="copy-field">
      <span className="copy-label">{label}</span>
      <code>{value}</code>
      {action}
      <button className="ghost bordered" onClick={() => void copy()} aria-live="polite">
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
