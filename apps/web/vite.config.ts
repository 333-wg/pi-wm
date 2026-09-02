import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
	plugins: [react()],
	server: {
		proxy: {
			"/api": {
				target: process.env.WUMING_GATEWAY_URL ?? "http://127.0.0.1:8787",
				ws: true,
			},
		},
	},
});
