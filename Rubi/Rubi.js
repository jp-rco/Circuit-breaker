// service-opossum.js
import CircuitBreaker from "opossum";
import fetch from "node-fetch";

const BUREAU_X_URL = "http://localhost:3001/score";
const BUREAU_Y_URL = "http://localhost:3002/score";

// Función principal: llamar al buró X
async function callBureauX() {
  const res = await fetch(BUREAU_X_URL);
  if (!res.ok) throw new Error("Buro X failed");
  const data = await res.text();
  return { used: "Buro X", result: data };
}

// Circuit Breaker sobre la función callBureauX
const options = {
  errorThresholdPercentage: 50, // 50% fallos
  resetTimeout: 30_000,         // 30s en OPEN antes de HALF-OPEN
  rollingCountBuckets: 10,      // 10 buckets (ventana estadística)
  rollingCountTimeout: 10_000,  // en 10s
};
const breaker = new CircuitBreaker(callBureauX, options);

// fallback: llamar al Buro Y
breaker.fallback(async () => {
  try {
    const res = await fetch(BUREAU_Y_URL);
    const data = await res.text();
    return { used: "Buro Y", result: data };
  } catch (err) {
    return { used: "Buro Y", result: "Error consultando Buro Y" };
  }
});

// Eventos útiles
breaker.on("open", () => console.log("[CB] -> OPEN"));
breaker.on("halfOpen", () => console.log("[CB] -> HALF-OPEN"));
breaker.on("close", () => console.log("[CB] -> CLOSED"));
breaker.on("fallback", () => console.log("[CB] fallback en acción"));

async function consultar() {
  try {
    const result = await breaker.fire();
    return { ...result, cb: breaker.status.stats };
  } catch (err) {
    return { used: "Buro X", result: err.message, cb: breaker.status.stats };
  }
}

// Servidor HTTP simple
import http from "http";
const server = http.createServer(async (req, res) => {
  if (req.url.startsWith("/consulta")) {
    const out = await consultar();
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(out, null, 2));
    return;
  }
  res.statusCode = 404;
  res.end("Not found");
});

server.listen(4000, () => console.log("Servicio con opossum en http://localhost:4000"));
