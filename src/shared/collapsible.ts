const DEFAULT_COLLAPSE_LINE_LIMIT = 6;
let collapsibleContentSeq = 0;

interface BuildCollapsibleContentHtmlOptions {
  blockClass: string;
  previewClass: string;
  fullClass: string;
  toggleClass: string;
  label: string;
  content: string | undefined;
  renderContent: (text: string) => string;
  idPrefix?: string;
  lineLimit?: number;
}

interface AttachCollapsibleToggleOptions {
  toggleSelector: string;
  previewSelector: string;
}

export function buildCollapsibleContentHtml({
  blockClass,
  previewClass,
  fullClass,
  toggleClass,
  label,
  content,
  renderContent,
  idPrefix = "collapsible-content",
  lineLimit = DEFAULT_COLLAPSE_LINE_LIMIT,
}: BuildCollapsibleContentHtmlOptions): string {
  const raw = content ?? "";
  const lines = raw.split(/\r?\n/);
  const previewText = lines.slice(0, lineLimit).join("\n");
  const hidden = lines.length > lineLimit;
  const previewHtml = renderContent(previewText);
  if (!previewHtml.trim()) return "";

  const contentId = `${idPrefix}-${++collapsibleContentSeq}`;
  const fullHtml = hidden ? renderContent(raw) : "";

  return `
<div class="${blockClass}">
  <div class="${previewClass}">${previewHtml}</div>
  ${hidden ? `<div class="${fullClass}" id="${contentId}" hidden>${fullHtml}</div>` : ""}
  ${hidden
    ? `<button class="${toggleClass}" type="button" aria-expanded="false" aria-controls="${contentId}" aria-label="${label} 전체 보기">더 보기</button>`
    : ""}
</div>`;
}

export function attachCollapsibleToggle(
  root: ParentNode,
  { toggleSelector, previewSelector }: AttachCollapsibleToggleOptions,
): void {
  const btn = root.querySelector(toggleSelector) as HTMLButtonElement | null;
  if (!btn || btn.dataset["bound"] === "yes") return;
  btn.dataset["bound"] = "yes";
  btn.addEventListener("click", () => {
    const contentId = btn.getAttribute("aria-controls");
    if (!contentId) return;
    const full = root.querySelector(`#${CSS.escape(contentId)}`) as HTMLElement | null;
    const preview = root.querySelector(previewSelector) as HTMLElement | null;
    if (!full || !preview) return;
    const expanded = btn.getAttribute("aria-expanded") === "true";
    btn.setAttribute("aria-expanded", expanded ? "false" : "true");
    btn.textContent = expanded ? "더 보기" : "접기";
    full.hidden = expanded;
    preview.hidden = !expanded;
  });
}
