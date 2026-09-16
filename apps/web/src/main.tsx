import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { LanguageProvider } from "./lib/locale.js";
import "./styles.css";
import { initializeDesktopConnection } from "./lib/desktop.js";
import { DesktopTitlebar } from "./components/DesktopTitlebar.js";

const windowChrome = Boolean(window.wumingDesktop?.windowChrome);
if (windowChrome) document.documentElement.dataset.desktopChrome = "true";

void initializeDesktopConnection()
	.then(() =>
		createRoot(document.getElementById("root")!).render(
			<StrictMode>
				<ErrorBoundary>
					<LanguageProvider>
						{windowChrome ? (
							<>
								<DesktopTitlebar />
								<div className="desktop-content">
									<App />
								</div>
							</>
						) : (
							<App />
						)}
					</LanguageProvider>
				</ErrorBoundary>
			</StrictMode>
		)
	)
	.catch(() => {
		document.getElementById("root")!.textContent = "Unable to connect to the local service. Restart Pi-Wm.";
	});
