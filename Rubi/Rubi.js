// service.js
const http = require("http");

const FAILURE_COUNT_THRESHOLD = 5;  // fallos consecutivos antes de abrir
const OPEN_TIMEOUT_MS = 30_000;     // espera antes del probe
const HALF_OPEN_PROBES = 1;         // número de probes permitidos

const BUREAU_X_URL = "http://localhost:3001/score";
const BUREAU_Y_URL = "http://localhost:3002/score";

// -------- Circuit Breaker --------
class CircuitBreaker {
  constructor({ failureCountThreshold, openTimeoutMs, halfOpenProbes }) {
    this.failureCountThreshold = failureCountThreshold;
    this.openTimeoutMs = openTimeoutMs;
    this.halfOpenProbes = halfOpenProbes;

    this.state = "CLOSED"; // CLOSED | OPEN | HALF_OPEN
    this.consecutiveFailures = 0;
    this.openUntil = 0;
    this.halfOpenRemaining = 0;
  }

  _toOpen() {
    this.state = "OPEN";
    this.openUntil = Date.now() + this.openTimeoutMs;
    console.log(`[CB] -> OPEN (>=${this.failureCountThreshold} fallos consec.)`);
  }
  _toHalfOpen() {
    this.state = "HALF_OPEN";
    this.halfOpenRemaining = this.halfOpenProbes;
    console.log("[CB] -> HALF_OPEN (intentando probe a X)");
  }
  _toClosed() {
    this.state = "CLOSED";
    this.consecutiveFailures = 0;
    console.log("[CB] -> CLOSED (recuperado, usando X)");
  }

  allowPrimary() {
    if (this.state === "CLOSED") return true;

    if (this.state === "OPEN") {
      if (Date.now() >= this.openUntil) {
        this._toHalfOpen();
        return true; // probe a X
      }
      return false; // usar Y mientras tanto
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

  onPrimarySuccess() {
    if (this.state === "HALF_OPEN") {
      this._toClosed();
      return;
    }
    this.consecutiveFailures = 0; // CLOSED
  }

  onPrimaryFailure() {
    if (this.state === "HALF_OPEN") {
      this._toOpen();
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureCountThreshold) {
      this._toOpen();
    }
  }

  snapshot() {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      failureCountThreshold: this.failureCountThreshold,
      openTimeoutMs: this.openTimeoutMs,
      openUntil: this.openUntil,
      now: Date.now(),
    };
  }
}

const breaker = new CircuitBreaker({
  failureCountThreshold: FAILURE_COUNT_THRESHOLD,
  openTimeoutMs: OPEN_TIMEOUT_MS,
  halfOpenProbes: HALF_OPEN_PROBES,
});

// -------- Helpers HTTP --------
async function call(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function consultar() {
  if (breaker.allowPrimary()) {
    try {
      const text = await call(BUREAU_X_URL);
      breaker.onPrimarySuccess();
      return { used: "Buro X", text, cb: breaker.state };
    } catch (e) {
      breaker.onPrimaryFailure();
      throw new Error(`Fallo Buro X: ${e.message} (cb=${breaker.state})`);
    }
  }

  // No se permite X -> usamos Y
  const text = await call(BUREAU_Y_URL);
  return { used: "Buro Y", text, cb: breaker.state };
}

// -------- API del servicio --------
const SERVICE_PORT = 4000;
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.url.startsWith("/consulta")) {
    try {
      const out = await consultar();
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, ...out }));
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
  console.log(`Servicio en http://localhost:${SERVICE_PORT}`)
);