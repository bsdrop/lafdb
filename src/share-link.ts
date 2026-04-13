/**
 * share-link.ts — shared copy-link utilities
 *
 * Exposes window.ShareLink with:
 *   copy(text, btn, opts?)  — clipboard copy + button feedback
 *   buildUrl(extra)         — merge extra params into current hash URL
 *   highlight(el)           — smooth-scroll + flash animation
 */

declare global {
  interface Window {
    ShareLink: {
      copy: (text: string, btn: HTMLElement | null, opts?: { successText?: string; resetText?: string; delay?: number }) => Promise<void>;
      buildUrl: (extra?: Record<string, string | null | undefined>) => string;
      highlight: (el: Element | null) => void;
    };
  }
}

(function () {
  // Inject shared CSS once
  const style = document.createElement("style");
  style.textContent = `
		.link-copied {
			color: #e5ff00 !important;
			border-color: rgba(229,255,0,.4) !important;
		}
		.link-copy-btn {
			font-size: 11px;
			color: #555;
			background: none;
			border: none;
			cursor: pointer;
			padding: 2px 5px;
			border-radius: 4px;
			line-height: 1;
			flex-shrink: 0;
			transition: color .15s;
			font-family: inherit;
		}
		.link-copy-btn:hover { color: #aaa; }
		@keyframes _anchor-flash {
			0%   { box-shadow: 0 0 0 2px #e5ff00; background: rgba(229,255,0,.07); }
			100% { box-shadow: 0 0 0 2px transparent; background: transparent; }
		}
		.anchor-highlight {
			animation: _anchor-flash 1.8s ease forwards;
			border-radius: inherit;
		}
	`;
  document.head.appendChild(style);

  async function copy(
    text: string,
    btn: HTMLElement | null,
    { successText = "✓", resetText, delay = 1800 }: { successText?: string; resetText?: string; delay?: number } = {},
  ): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch (_e) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;top:-9999px;left:-9999px;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    if (!btn) return;
    const orig = resetText ?? btn.textContent;
    btn.textContent = successText;
    btn.classList.add("link-copied");
    setTimeout(() => {
      btn.textContent = orig;
      btn.classList.remove("link-copied");
    }, delay);
  }

  /** Merge extraParams into current location.hash and return full URL. */
  function buildUrl(extra: Record<string, string | null | undefined> = {}): string {
    const p = new URLSearchParams(location.hash.slice(1));
    for (const [k, v] of Object.entries(extra)) {
      if (v == null) p.delete(k);
      else p.set(k, String(v));
    }
    return `${location.origin}${location.pathname}#${p.toString()}`;
  }

  /** Scroll element into view and flash it. */
  function highlight(el: Element | null): void {
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.remove("anchor-highlight");
    // force reflow so re-triggering works
    void (el as HTMLElement).offsetWidth;
    el.classList.add("anchor-highlight");
    el.addEventListener(
      "animationend",
      () => el.classList.remove("anchor-highlight"),
      { once: true },
    );
  }

  window.ShareLink = { copy, buildUrl, highlight };
})();

export {};
