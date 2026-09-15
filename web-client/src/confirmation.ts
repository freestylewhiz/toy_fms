export type DeletionResource = {
  kind: string;
  id: string;
  name: string;
};

let pendingConfirmation: Promise<boolean> | null = null;

function validItems(items: DeletionResource[]): boolean {
  return (
    Array.isArray(items) &&
    items.length > 0 &&
    items.every(
      (item) =>
        item !== null &&
        typeof item === "object" &&
        typeof item.kind === "string" &&
        item.kind.trim().length > 0 &&
        typeof item.id === "string" &&
        item.id.trim().length > 0 &&
        typeof item.name === "string" &&
        item.name.trim().length > 0,
    )
  );
}

function makeElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  return element;
}

/**
 * Ask the user to explicitly confirm an irreversible resource deletion.
 * Concurrent requests cannot reuse approval for a different deletion.
 */
export async function confirmResourceDeletion(
  items: DeletionResource[],
): Promise<boolean> {
  if (!validItems(items) || typeof document === "undefined" || !document.body) {
    return false;
  }

  if (pendingConfirmation) return false;

  const dialog = makeElement("dialog", "confirm-dialog");
  dialog.id = "delete-dialog";
  dialog.setAttribute("aria-labelledby", "delete-title");
  dialog.setAttribute("aria-describedby", "delete-note");

  const eyebrow = makeElement("div", "dialog-eyebrow");
  eyebrow.textContent = "리소스 삭제";
  const icon = makeElement("div", "dialog-icon");
  icon.textContent = "!";
  icon.setAttribute("aria-hidden", "true");
  const title = makeElement("h2");
  title.id = "delete-title";
  title.textContent =
    items.length === 1
      ? "이 리소스를 삭제할까요?"
      : `${items.length}개 리소스를 삭제할까요?`;

  const list = makeElement("div");
  list.id = "delete-items";
  list.setAttribute("role", "list");
  items.slice(0, 8).forEach((item) => {
    const row = makeElement("div", "delete-item");
    row.setAttribute("role", "listitem");
    const name = makeElement("div", "delete-item-name");
    name.textContent = item.name;
    const meta = makeElement("div", "delete-item-meta");
    meta.textContent = `${item.kind} · ${item.id}`;
    row.append(name, meta);
    list.append(row);
  });
  if (items.length > 8) {
    const more = makeElement("div", "delete-item-meta");
    more.textContent = `외 ${items.length - 8}개`;
    list.append(more);
  }

  const note = makeElement("p", "dialog-note");
  note.id = "delete-note";
  note.textContent = "이 작업은 되돌릴 수 없습니다.";
  const actions = makeElement("div", "dialog-actions");
  const cancel = makeElement("button", "confirm-secondary");
  cancel.id = "delete-cancel";
  cancel.type = "button";
  cancel.textContent = "취소";
  const confirm = makeElement("button", "confirm-danger");
  confirm.id = "delete-confirm";
  confirm.type = "button";
  confirm.textContent = "삭제";
  actions.append(cancel, confirm);

  dialog.append(eyebrow, icon, title, list, note, actions);
  document.body.append(dialog);

  const previouslyFocused =
    document.activeElement instanceof HTMLElement ? document.activeElement : null;

  let resolveConfirmation!: (result: boolean) => void;
  let settled = false;
  pendingConfirmation = new Promise<boolean>((resolve) => {
    resolveConfirmation = resolve;
  });
  const resultPromise = pendingConfirmation;
  const settle = (result: boolean) => {
    if (settled) return;
    settled = true;
    if (dialog.open) dialog.close();
    if (previouslyFocused?.isConnected) previouslyFocused.focus();
    dialog.remove();
    pendingConfirmation = null;
    resolveConfirmation(result);
  };

  confirm.addEventListener("click", () => settle(true));
  cancel.addEventListener("click", () => settle(false));
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    settle(false);
  });
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) settle(false);
    }
  });
  // Enter must never become an accidental destructive default action.
  dialog.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter" && event.target !== confirm && event.target !== cancel) event.preventDefault();
  });
  dialog.addEventListener("close", () => settle(false));

  if (typeof dialog.showModal !== "function") {
    settle(false);
  } else {
    try {
      dialog.showModal();
      cancel.focus();
    } catch {
      settle(false);
    }
  }

  return resultPromise;
}
