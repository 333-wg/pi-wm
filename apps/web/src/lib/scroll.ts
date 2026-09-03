// Whether the transcript should keep following the newest output.
//
// A transcript that scrolls to the bottom on every change is unreadable while a
// turn streams: each delta yanks the view away from whatever the reader scrolled
// up to look at. The rule is to follow the tail only while the reader is already
// sitting at it, so these helpers turn a scroll container's geometry into that
// single decision.

export interface ScrollMetrics {
	scrollTop: number;
	clientHeight: number;
	scrollHeight: number;
}

/** Pixels of content still hidden below the viewport; 0 means the tail is on screen. */
export function distanceFromBottom({ scrollTop, clientHeight, scrollHeight }: ScrollMetrics): number {
	// Overscroll (rubber banding, or a scrollHeight that shrank before the scroll
	// event landed) can report a scrollTop past the real maximum.
	return Math.max(0, scrollHeight - clientHeight - scrollTop);
}

/**
 * The threshold is deliberately taller than one line: a reader a few pixels off
 * the bottom — a trackpad nudge, or the fractional scrollTop a zoomed display
 * produces — still means to follow along.
 */
export function isNearBottom(metrics: ScrollMetrics, threshold = 72): boolean {
	return distanceFromBottom(metrics) <= threshold;
}
