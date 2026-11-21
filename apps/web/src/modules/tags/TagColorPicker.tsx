import type { TagColor } from "../../types";
import { TAG_COLOR_LABELS, TAG_COLORS, tagColorClass } from "./tagColors";

export function TagColorPicker({
  value,
  onChange,
  label = "Tag color",
  disabled = false,
}: {
  value: TagColor;
  onChange: (color: TagColor) => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <div className="tag-color-picker" role="radiogroup" aria-label={label}>
      {TAG_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={value === color}
          aria-label={TAG_COLOR_LABELS[color]}
          title={TAG_COLOR_LABELS[color]}
          className={`tag-swatch ${tagColorClass(color)}`}
          disabled={disabled}
          onClick={() => onChange(color)}
        >
          {value === color && <span aria-hidden="true">✓</span>}
        </button>
      ))}
    </div>
  );
}
