export async function copyToClipboard(text: string, btn: HTMLElement): Promise<void> {
  let copied = false;
  try {
    await navigator.clipboard.writeText(text);
    copied = true;
  } catch (e) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;top:-9999px";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); copied = true; } catch { /* ignore */ }
    ta.remove();
  }
  if (copied) {
    btn.textContent = "✓ 복사됨";
    btn.classList.add("copied");
    setTimeout(() => { btn.textContent = "복사"; btn.classList.remove("copied"); }, 2000);
  }
}

export function mountShareSheet(
  overlay: HTMLElement,
  sheet: HTMLElement,
  rowsEl: HTMLElement | null,
): { open(): void; close(): void } {
  let raised = false;

  function open(): void {
    raised = false;
    sheet.classList.remove("raised");
    sheet.style.transform = "";
    overlay.classList.add("open");
    sheet.classList.add("open");
    sheet.setAttribute("aria-hidden", "false");
    history.pushState({ shareSheet: true }, "");
  }

  function close(): void {
    raised = false;
    sheet.classList.remove("raised");
    sheet.style.transition = "";
    sheet.style.transform = "";
    overlay.classList.remove("open");
    sheet.classList.remove("open");
    sheet.setAttribute("aria-hidden", "true");
    if (history.state?.shareSheet) history.back();
  }

  window.addEventListener("popstate", (e) => {
    if (sheet.classList.contains("open") && !e.state?.shareSheet) {
      raised = false;
      sheet.classList.remove("raised");
      sheet.style.transition = "";
      sheet.style.transform = "";
      overlay.classList.remove("open");
      sheet.classList.remove("open");
      sheet.setAttribute("aria-hidden", "true");
    }
  });

  overlay.addEventListener("click", close);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && sheet.classList.contains("open")) close();
  });

  {
    let touchStartY = 0;
    let raisedPx = 0;
    let touchIntent: "pending" | "drag" | "scroll" = "pending";
    let touchInRows = false;

    sheet.addEventListener("touchstart", (e) => {
      touchStartY = e.touches[0].clientY;
      raisedPx = -Math.round(window.innerHeight * 0.42);
      touchInRows = !!rowsEl?.contains(e.target as Node);
      touchIntent = "pending";
    }, { passive: true });

    sheet.addEventListener("touchmove", (e) => {
      const dy = e.changedTouches[0].clientY - touchStartY;
      if (touchIntent === "pending") {
        if (Math.abs(dy) < 6) return;
        const canDrag = !touchInRows || (rowsEl?.scrollTop ?? 0) <= 0;
        if (canDrag && (dy < -6 || dy > 6)) {
          touchIntent = "drag";
          sheet.style.transition = "none";
        } else {
          touchIntent = "scroll";
          return;
        }
      }
      if (touchIntent !== "drag") return;
      e.preventDefault();
      const base = raised ? raisedPx : 0;
      sheet.style.transform = `translateY(${Math.max(raisedPx, base + dy)}px)`;
    }, { passive: false });

    sheet.addEventListener("touchend", (e) => {
      if (touchIntent !== "drag") { touchIntent = "pending"; return; }
      const dy = e.changedTouches[0].clientY - touchStartY;
      sheet.style.transition = "";
      if (raised) {
        if (dy > 40) {
          raised = false;
          sheet.classList.remove("raised");
          sheet.style.transform = "";
        } else {
          sheet.style.transform = `translateY(${raisedPx}px)`;
        }
      } else {
        if (dy < -40) {
          raised = true;
          sheet.classList.add("raised");
          sheet.style.transform = `translateY(${raisedPx}px)`;
        } else if (dy > 40) {
          sheet.style.transform = "";
          close();
        } else {
          sheet.style.transform = "";
        }
      }
      touchIntent = "pending";
    }, { passive: true });
  }

  return { open, close };
}
