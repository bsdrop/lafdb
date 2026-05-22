const DEFAULT_COLLAPSE_LINE_LIMIT = 6;

interface BuildCollapsibleContentHtmlOptions {
  blockClass: string;
  contentClass: string;
  toggleClass: string;
  collapsedClass: string;
  label: string;
  content: string | undefined;
  renderContent: (text: string) => string;
  lineLimit?: number;
}

interface AttachCollapsibleToggleOptions {
  blockSelector: string;
  contentSelector: string;
  toggleSelector: string;
  collapsedClass: string;
}

export function buildCollapsibleContentHtml({
  blockClass,
  contentClass,
  toggleClass,
  collapsedClass,
  label,
  content,
  renderContent,
  lineLimit = DEFAULT_COLLAPSE_LINE_LIMIT,
}: BuildCollapsibleContentHtmlOptions): string {
  const innerHtml = renderContent(content ?? "");
  if (!innerHtml.trim()) return "";

  return `
<div class="${blockClass}" data-collapse-lines="${lineLimit}">
  <div class="${contentClass} ${collapsedClass}">${innerHtml}</div>
  <button class="${toggleClass}" type="button" aria-expanded="false" aria-label="${label} 전체 보기" hidden>더 보기</button>
</div>`;
}

export function attachCollapsibleToggle(
  root: ParentNode,
  { blockSelector, contentSelector, toggleSelector, collapsedClass }: AttachCollapsibleToggleOptions,
): void {
  const block = root.querySelector(blockSelector) as HTMLElement | null;
  const content = root.querySelector(contentSelector) as HTMLElement | null;
  const btn = root.querySelector(toggleSelector) as HTMLButtonElement | null;
  if (!block || !content || !btn) return;

  let expanded = btn.getAttribute("aria-expanded") === "true";

  const syncButton = (): void => {
    const wasExpanded = expanded;
    if (!expanded) content.classList.add(collapsedClass);
    const isOverflowed = content.scrollHeight - content.clientHeight > 1;
    btn.hidden = !isOverflowed && !expanded;
    if (!isOverflowed && !expanded) {
      content.classList.remove(collapsedClass);
      return;
    }
    content.classList.toggle(collapsedClass, !expanded);
    if (wasExpanded) btn.hidden = false;
  };

  if (btn.dataset["bound"] !== "yes") {
    btn.dataset["bound"] = "yes";
    btn.addEventListener("click", () => {
      expanded = btn.getAttribute("aria-expanded") !== "true";
      btn.setAttribute("aria-expanded", expanded ? "true" : "false");
      btn.textContent = expanded ? "접기" : "더 보기";
      syncButton();
    });
  }

  if (block.dataset["collapseObserved"] !== "yes") {
    block.dataset["collapseObserved"] = "yes";
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => {
        syncButton();
      });
      observer.observe(content);
    } else {
      const handler = () => syncButton();
      window.addEventListener("resize", handler, { passive: true });
    }
  }

  requestAnimationFrame(() => {
    syncButton();
  });
}
