import { useEffect, useRef, type RefObject } from "react";

// Elements the browser stops on while tabbing. Anything with a negative
// tabindex is reachable by script but not by Tab, so it stays out.
const FOCUSABLE = [
	"a[href]",
	"button:not([disabled])",
	"input:not([disabled])",
	"select:not([disabled])",
	"textarea:not([disabled])",
	'[tabindex]:not([tabindex^="-"])',
].join(", ");

/**
 * Everything inside `root` that Tab can reach, in document order.
 *
 * Read on every Tab rather than cached once: the palette's rows change as the
 * query narrows, and a remembered last row would send focus to a button that is
 * no longer rendered.
 */
function focusableWithin(root: HTMLElement): HTMLElement[] {
	return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
		(element) => element.getClientRects().length > 0 && element.getAttribute("aria-hidden") !== "true",
	);
}

/**
 * Keeps keyboard focus inside an overlay while it is open, then hands it back.
 *
 * A dialog is only visually on top: without this, Tab walks out of it into the
 * page behind, and closing one leaves focus on `<body>` so the next keystroke
 * goes nowhere — after `Ctrl+K` `Esc` the composer has to be clicked again.
 * `aria-modal` tells a screen reader the overlay is exclusive but moves no
 * focus, so both halves are done here.
 *
 * Attach the returned ref to the element carrying `role="dialog"`.
 */
export function useFocusTrap<T extends HTMLElement>(): RefObject<T | null> {
	const ref = useRef<T | null>(null);
	useEffect(() => {
		const root = ref.current;
		if (!root) return;
		// Read before anything is moved, so it is whatever the user was on when
		// the overlay opened.
		const opener = document.activeElement;
		// An overlay that focuses its own control (the palette's input) has already
		// done this by the time the effect runs.
		if (!root.contains(document.activeElement)) (focusableWithin(root)[0] ?? root).focus();
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Tab") return;
			const targets = focusableWithin(root);
			const first = targets[0];
			const last = targets[targets.length - 1];
			if (!first || !last) {
				// Nothing to land on, so the only way to stay is to go nowhere.
				event.preventDefault();
				return;
			}
			const active = document.activeElement;
			const leaving = event.shiftKey ? active === first : active === last;
			if (!leaving && root.contains(active)) return;
			event.preventDefault();
			(event.shiftKey ? last : first).focus();
		};
		// Capture: a row that binds Tab itself cannot swallow the wrap.
		document.addEventListener("keydown", onKeyDown, true);
		return () => {
			document.removeEventListener("keydown", onKeyDown, true);
			// The opener can be gone by now — a forked message row, or a session
			// entry the command just removed.
			if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
		};
	}, []);
	return ref;
}
