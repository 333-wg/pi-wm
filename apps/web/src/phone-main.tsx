import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PhoneApp } from "./PhoneApp.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<ErrorBoundary>
			<PhoneApp />
		</ErrorBoundary>
	</StrictMode>
);
