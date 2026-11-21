import { useEffect, useRef } from "react";

export type CheckboxModifiers = { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean };

export function SelectCheckbox({
  checked,
  indeterminate = false,
  label,
  className = "",
  tabIndex,
  onChange,
}: {
  checked: boolean;
  indeterminate?: boolean;
  label: string;
  className?: string;
  tabIndex?: number;
  /** Modifier keys come from the click, not the later `change` event. */
  onChange: (modifiers: CheckboxModifiers) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const modifiers = useRef<CheckboxModifiers>({ shiftKey: false, metaKey: false, ctrlKey: false });

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <input
      ref={ref}
      type="checkbox"
      className={`select-checkbox${className ? ` ${className}` : ""}`}
      checked={checked}
      aria-label={label}
      tabIndex={tabIndex}
      onClick={(event) => {
        event.stopPropagation();
        modifiers.current = { shiftKey: event.shiftKey, metaKey: event.metaKey, ctrlKey: event.ctrlKey };
      }}
      onChange={() => onChange(modifiers.current)}
    />
  );
}
