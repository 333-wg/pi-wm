/** Horizontal cubic tangents stay within adjacent values: no artificial overshoot or negative usage. */
export function usageTrendGeometry(values: readonly number[]) {
	const safe = values.map((value) => (Number.isFinite(value) ? Math.max(0, value) : 0));
	const max = Math.max(0, ...safe);
	const magnitude = 10 ** Math.floor(Math.log10(max || 1));
	const ceiling = max === 0 ? 1 : Math.ceil(max / magnitude) * magnitude;
	const points = safe.map((value, index) => ({
		x: safe.length === 1 ? 320 : 12 + (index * 616) / (safe.length - 1),
		y: 160 - (value / ceiling) * 160,
	}));
	const first = points[0];
	const last = points.at(-1);
	let line = first ? `M ${first.x} ${first.y}` : "";
	for (let index = 1; index < points.length; index++) {
		const previous = points[index - 1]!;
		const point = points[index]!;
		const middle = (previous.x + point.x) / 2;
		line += ` C ${middle} ${previous.y}, ${middle} ${point.y}, ${point.x} ${point.y}`;
	}
	return { ceiling, points, line, area: first && last ? `${line} L ${last.x} 160 L ${first.x} 160 Z` : "" };
}
