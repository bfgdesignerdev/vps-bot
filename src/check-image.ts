import { ensureImage } from "./docker.js";
try { console.log("OK образ:", await ensureImage()); } catch (e) { console.error("ОШИБКА:", (e as Error).message); process.exit(1); }
