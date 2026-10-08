// Select before loading either application: phones must not download the desktop workbench.
void (location.pathname === "/phone" ? import("./phone-main.js") : import("./desktop-main.js")).catch(() => {
	const root = document.getElementById("root");
	if (root) root.textContent = "页面加载失败，请检查网络后刷新重试。";
});
