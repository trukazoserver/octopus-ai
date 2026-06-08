import React from "react";
import ReactDOM from "react-dom/client";
import "../../../web/src/styles/global.css";
import { App } from "../../../web/src/app/App.js";

const rootElement = document.getElementById("root");
if (rootElement) {
	ReactDOM.createRoot(rootElement).render(
		<React.StrictMode>
			<App />
		</React.StrictMode>,
	);
}
