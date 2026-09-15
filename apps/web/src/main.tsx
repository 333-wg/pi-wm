import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { LanguageProvider } from "./lib/locale.js";
import "./styles.css";
import { initializeDesktopConnection } from "./lib/desktop.js";

void initializeDesktopConnection()
	.then(() =>
		createRoot(document.getElementById("root")!).render(
			<StrictMode>
				<ErrorBoundary>
					<LanguageProvider>
						<App />
					</LanguageProvider>
				</ErrorBoundary>
			</StrictMode>
		)
	)
	.catch(() => {
		document.getElementById("root")!.textContent = "Unable to connect to the local service. Restart Pi-Wm.";
	});
