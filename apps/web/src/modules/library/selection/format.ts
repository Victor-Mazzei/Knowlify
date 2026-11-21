const counter = new Intl.NumberFormat("en-US");

export function uiCount(value: number): string {
  return counter.format(value);
}
