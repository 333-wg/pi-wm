import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup as render } from "react-dom/server";
import { LanguageProvider, type Locale } from "../src/lib/locale.js";

export function renderLocalized(node: ReactNode, locale: Locale = "zh"): string {
	return render(createElement(LanguageProvider, { initialLocale: locale, children: node }));
}
