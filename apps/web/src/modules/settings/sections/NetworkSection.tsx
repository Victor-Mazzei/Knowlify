import { isDesktopShell } from "../../../services/desktop";
import { ShareCard } from "../share/ShareCard";

/** Outside the desktop shell the card is not mounted at all. */
export default function NetworkSection() {
  return isDesktopShell() ? <ShareCard /> : null;
}
