// service.js
// Node >= 18
const http = require("http");

// -------- Config CB ----------
const WINDOW_SIZE = 10;          // ventana deslizante (N últimas llamadas)
const FAILURE_THRESHOLD = 0.5;   // 50% de fallos
const OPEN_TIMEOUT_MS = 30_000;  // 30 s en OPEN
const HALF_OPEN_PROBES = 1;      // 1 llamada de prueba en HALF_OPEN

// -------- URLs de burós ------
const BUREAU_X_URL = process.env.BUREAU_X_URL || "http://localhost:3001/score";
const BUREAU_Y_URL = process.env.BUREAU_Y_URL || "http://localhost:3002/score";

// -------- Circuit Breaker ----
class CircuitBreaker {
  constructor({ windowSize, failureThreshold, openTimeoutMs, halfOpenProbes }) {
    this.windowSize = windowSize;
    this.failureThreshold = failureThreshold;
    this.openTimeoutMs = openTimeoutMs;
    this.halfOpenProbes = halfOpenProbes;

    this.state = "CLOSED";         // CLOSED | OPEN | HALF_OPEN
    this.results = [];             // true=ok, false=fail (sliding window)
    this.openUntil = 0;
    this.halfOpenRemaining = 0;
  }

  _pushResult(ok) {
    this.results.push(Boolean(ok));
    if (this.results.length > this.windowSize) this.results.shift();
  }
  _failureRate() {
    if (this.results.length === 0) return 0;
    const fails = this.results.filter(v => !v).length;
    return fails / this.results.length;
  }
  _toOpen() {
    this.state = "OPEN";
    this.openUntil = Date.now() + this.openTimeoutMs;
    console.log(`[CB] -> OPEN (${this.openTimeoutMs / 1000}s)`);
  }
  _toHalfOpen() {
    this.state = "HALF_OPEN";
    this.halfOpenRemaining = this.halfOpenProbes;
    console.log("[CB] -> HALF_OPEN (1 probe)");
  }
  _toClosed() {
    this.state = "CLOSED";
    this.results = [];
    console.log("[CB] -> CLOSED (recuperado)");
  }

  allowPrimary() {
    if (this.state === "CLOSED") return true;
    if (this.state === "OPEN") {
      if (Date.now() >= this.openUntil) {
        this._toHalfOpen();
        return true; // probe
      }
      return false; // aún bloqueado
    }
    if (this.state === "HALF_OPEN") {
      if (this.halfOpenRemaining > 0) {
        this.halfOpenRemaining -= 1;
        return true; // único probe
      }
      return false;
    }
    return false;
  }

  onPrimaryResult(success) {
    if (this.state === "HALF_OPEN") {
      if (success) this._toClosed();
      else this._toOpen();
      return;
    }
    // CLOSED
    this._pushResult(success);
    const rate = this._failureRate();
    if (this.results.length >= this.windowSize && rate >= this.failureThreshold) {
      this._toOpen();
    }
  }

  snapshot() {
    return {
      state: this.state,
      windowSize: this.windowSize,
      failureThreshold: this.failureThreshold,
      openTimeoutMs: this.openTimeoutMs,
      results: this.results,
      failureRate: this._failureRate(),
      openUntil: this.openUntil,
      now: Date.now(),
    };
  }
}

const breaker = new CircuitBreaker({
  windowSize: WINDOW_SIZE,
  failureThreshold: FAILURE_THRESHOLD,
  openTimeoutMs: OPEN_TIMEOUT_MS,
  halfOpenProbes: HALF_OPEN_PROBES,
});

// -------- funciones HTTP -----
async function call(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function consultar() {
  // ¿intentamos con el primario (X)?
  if (breaker.allowPrimary()) {
    try {
      const text = await call(BUREAU_X_URL);
      breaker.onPrimaryResult(true);
      return { used: "Buro X", text, breaker: breaker.state };
    } catch (e) {
      breaker.onPrimaryResult(false);
      // fallback inmediato a Y
      const text = await call(BUREAU_Y_URL);
      return { used: "Buro Y (fallback)", text, breaker: breaker.state };
    }
  }
  // si OPEN o HALF_OPEN sin probe disponible => usar Y directo
  const text = await call(BUREAU_Y_URL);
  return { used: "Buro Y (forced)", text, breaker: breaker.state };
}

// -------- API HTTP del servicio -----
const SERVICE_PORT = process.env.SERVICE_PORT || 4000;

const server = http.createServer(async (req, res) => {
  // CORS básico para pruebas
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.statusCode = 204; res.end(); return;
  }

  if (req.url.startsWith("/consulta")) {
    try {
      const out = await consultar();
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        ok: true,
        used: out.used,
        message: out.text,
        cbState: out.breaker,
      }));
    } catch (err) {
      res.statusCode = 502;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (req.url.startsWith("/cb")) {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(breaker.snapshot(), null, 2));
    return;
  }

  res.statusCode = 404;
  res.end("Not found");
});

server.listen(SERVICE_PORT, () =>
  console.log(`Servicio escuchando en http://localhost:${SERVICE_PORT}`));
