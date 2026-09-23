import { upcomingCalendarRuns, type AutomationSchedule, type CalendarSchedule } from "@wuming/protocol";

export function scheduleLabel(schedule: AutomationSchedule): string {
	if (schedule.kind === "once") return "一次性";
	if (schedule.kind === "interval") return `每 ${schedule.everyMinutes} 分钟`;
	const days = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
	const frequency =
		schedule.frequency === "daily"
			? "每天"
			: schedule.frequency === "monthly"
				? `每月 ${schedule.dayOfMonth} 日`
				: (schedule.weekdays ?? []).map((day) => days[day]).join("、");
	return `${frequency} ${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")} · ${schedule.timeZone}`;
}

export function SchedulePreview({ schedule }: { schedule: AutomationSchedule }) {
	let times: number[] = [];
	try {
		const now = Date.now();
		if (schedule.kind === "calendar") times = upcomingCalendarRuns(schedule, now, 3);
		else if (schedule.kind === "once") times = [schedule.runAt];
		else {
			const interval = schedule.everyMinutes * 60_000;
			if (!Number.isFinite(interval) || interval < 60_000) throw new Error("请填写有效间隔");
			const first =
				schedule.startsAt > now
					? schedule.startsAt
					: schedule.startsAt + (Math.floor((now - schedule.startsAt) / interval) + 1) * interval;
			times = [first, first + interval, first + 2 * interval];
		}
		const format = new Intl.DateTimeFormat("zh-CN", {
			timeZone: schedule.kind === "calendar" ? schedule.timeZone : undefined,
			dateStyle: "medium",
			timeStyle: "short",
		});
		return (
			<div className="automation-preview">
				<strong>未来运行时间</strong>
				{times.map((time) => (
					<div key={time}>{format.format(time)}</div>
				))}
			</div>
		);
	} catch {
		return <div role="alert">请检查时间、时区和星期配置。</div>;
	}
}

export function CalendarScheduleEditor({
	value,
	onChange,
	disabled,
}: {
	value: CalendarSchedule;
	onChange: (value: CalendarSchedule) => void;
	disabled: boolean;
}) {
	const changeFrequency = (frequency: CalendarSchedule["frequency"]) => {
		const { weekdays: _weekdays, dayOfMonth: _day, ...base } = value;
		onChange({
			...base,
			frequency,
			...(frequency === "weekly" ? { weekdays: [1, 2, 3, 4, 5] } : frequency === "monthly" ? { dayOfMonth: 1 } : {}),
		});
	};
	return (
		<fieldset disabled={disabled} className="automation-calendar">
			<legend>日历日程</legend>
			<label>
				<span>频率</span>
				<select
					value={value.frequency}
					onChange={(e) => changeFrequency(e.target.value as CalendarSchedule["frequency"])}
				>
					<option value="daily">每天</option>
					<option value="weekly">每周 / 工作日</option>
					<option value="monthly">每月</option>
				</select>
			</label>
			<label>
				<span>运行时刻</span>
				<input
					type="time"
					required
					value={`${String(value.hour).padStart(2, "0")}:${String(value.minute).padStart(2, "0")}`}
					onChange={(e) => {
						const [hour, minute] = e.target.value.split(":").map(Number);
						onChange({ ...value, hour: hour ?? 0, minute: minute ?? 0 });
					}}
				/>
			</label>
			<label>
				<span>时区</span>
				<input
					required
					value={value.timeZone}
					placeholder="Asia/Shanghai"
					onChange={(e) => onChange({ ...value, timeZone: e.target.value })}
				/>
			</label>
			{value.frequency === "weekly" && (
				<div className="automation-weekdays">
					{["周日", "周一", "周二", "周三", "周四", "周五", "周六"].map((day, index) => (
						<label key={day}>
							<input
								type="checkbox"
								checked={value.weekdays?.includes(index) ?? false}
								onChange={(e) =>
									onChange({
										...value,
										weekdays: e.target.checked
											? [...(value.weekdays ?? []), index].sort()
											: (value.weekdays?.filter((d) => d !== index) ?? []),
									})
								}
							/>
							{day}
						</label>
					))}
				</div>
			)}
			{value.frequency === "monthly" && (
				<label>
					<span>每月日期</span>
					<input
						type="number"
						aria-label="每月日期"
						min={1}
						max={31}
						required
						value={value.dayOfMonth ?? 1}
						onChange={(e) => onChange({ ...value, dayOfMonth: Number(e.target.value) })}
					/>
					<small>当月不存在该日期时跳过。</small>
				</label>
			)}
			<small>夏令时缺失时刻跳过；重复时刻只运行第一次。</small>
		</fieldset>
	);
}
