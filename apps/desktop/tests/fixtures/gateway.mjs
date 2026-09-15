if (process.env.WUMING_RUNTIME === "early-exit") process.exit(1);
if (process.env.WUMING_RUNTIME !== "timeout") process.send({ type: "desktop.ready", port: 12345 });
process.on("message", (message) => {
	if (message.type === "desktop.shutdown" && process.env.WUMING_RUNTIME !== "timeout") process.exit(0);
});
setInterval(() => {}, 1000);
