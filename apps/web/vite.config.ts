import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
	plugins: [react()],
	server: {
		host: "127.0.0.1",
		port: Number(process.env.WUMING_WEB_PORT ?? "5173"),
		proxy: {
			"/api": {
				target: process.env.WUMING_GATEWAY_URL ?? "http://127.0.0.1:8787",
				ws: true,
			},
		},
	},
});
