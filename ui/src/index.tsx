import { render } from "solid-js/web";
import App from "./App";
import "./styles/style.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("No se encontró el elemento #root");
}

render(() => <App />, root);
