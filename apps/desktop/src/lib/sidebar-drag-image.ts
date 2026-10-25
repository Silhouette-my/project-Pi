/**
 * Native drag preview for sidebar rows: a compact pill (optional icon plus a
 * truncated title) rendered offscreen for one frame. Browsers snapshot the
 * element synchronously inside `dragstart`, so it is removed right after.
 */
export function setSidebarDragImage(
  event: { dataTransfer: DataTransfer },
  title: string,
  icon?: Element | null,
) {
  if (typeof document === "undefined" || !event.dataTransfer.setDragImage) return;
  const pill = document.createElement("div");
  pill.className = "sidebar-drag-pill";
  if (icon) {
    const slot = document.createElement("span");
    slot.className = "sidebar-drag-pill-icon";
    slot.append(icon.cloneNode(true));
    pill.append(slot);
  }
  const label = document.createElement("span");
  label.className = "sidebar-drag-pill-title";
  label.textContent = title;
  pill.append(label);
  document.body.append(pill);
  event.dataTransfer.setDragImage(pill, 14, 14);
  setTimeout(() => pill.remove(), 0);
}
