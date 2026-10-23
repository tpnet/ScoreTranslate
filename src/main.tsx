import { createRoot } from "react-dom/client";
import App from "./App";
import { MuseScoreNotice } from "./MuseScoreNotice";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<><MuseScoreNotice /><App /></>);
