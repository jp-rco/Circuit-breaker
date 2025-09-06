const http = require("http");

// --- Config ---
const FAILURE_COUNT_THRESHOLD = 5;   
const OPEN_TIMEOUT_MS = 30_000;      
const HALF_OPEN_PROBES = 1;           
const EAGER_PROBE_TIMEOUT_MS = 800;  // probe rápido en cada request estando OPEN
const HEARTBEAT_INTERVAL_MS = 2000;  // latido para probar X en background cuando OPEN

// --- URLs ---
const BUREAU_X_URL = process.env.BUREAU_X_URL || "http://localhost:3001/score";
const BUREAU_Y_URL = process.env.BUREAU_Y_URL || "http://localhost:3002/score";

// --- Circuit Breaker (fallos consecutivos) ---
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
    if (this.state !== "OPEN") {
      this.state = "OPEN";
      this.openUntil = Date.now() + this.openTimeoutMs;
      console.log(`[CB] -> OPEN (>=${this.failureCountThreshold} fallos consec.)`);
    } else {
      this.openUntil = Date.now() + this.openTimeoutMs; // refresca cooldown
    }
  }
  _toHalfOpen() {
    this.state = "HALF_OPEN";
    this.halfOpenRemaining = this.halfOpenProbes;
    console.log("[CB] -> HALF_OPEN (probe formal a X)");
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
        return true; // permitirá 1 probe "formal"
      }
      return false; // en OPEN, no permitiría X (salvo eager/heartbeat)
    }

    if (this.state === "HALF_OPEN") {
      if (this.halfOpenRemaining > 0) {
        this.halfOpenRemaining -= 1;
        return true;
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
    // CLOSED
    this.consecutiveFailures = 0;
  }

  onPrimaryFailure() {
    if (this.state === "HALF_OPEN") {
      this._toOpen();
      return;
    }
    // CLOSED
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

// --- Helpers HTTP ---
async function call(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function callWithTimeout(url, ms) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  } finally {
    clearTimeout(t);
  }
}

// --- Heartbeat en background (solo cuando OPEN) ---
let heartbeatRunning = false;
async function heartbeatLoop() {
  if (heartbeatRunning) return;
  heartbeatRunning = true;

  const run = async () => {
    // solo tiene sentido si estamos en OPEN
    if (breaker.state === "OPEN") {
      try {
        await callWithTimeout(BUREAU_X_URL, EAGER_PROBE_TIMEOUT_MS);
        console.log("[HB] X respondió OK → cerrando CB y volviendo a X");
        breaker._toClosed();
      } catch {
        // sigue caído o lento; no hacemos nada
        // (dejamos Y activo y reintentamos en el próximo tick)
      }
    }
    setTimeout(run, HEARTBEAT_INTERVAL_MS);
  };

  run();
}
heartbeatLoop();

// --- Lógica por request ---
async function consultar() {
  console.log(`[REQ] estado=${breaker.state}, consecFails=${breaker.consecutiveFailures}`);

  // 1) CLOSED o HALF_OPEN (formal)
  if (breaker.allowPrimary()) {
    console.log("[REQ] Intentando X (permitido por CB)...");
    try {
      const text = await call(BUREAU_X_URL);
      breaker.onPrimarySuccess();
      return { ok: true, used: "Buro X", text, cb: breaker.state };
    } catch (e) {
      breaker.onPrimaryFailure(); // puede abrirse aquí si alcanzó umbral
      // *** No hay fallback antes del umbral: devolvemos error ***
      throw new Error(`Fallo Buro X: ${e.message} (cb=${breaker.state})`);
    }
  }

  // 2) OPEN con eager probe en la misma request
  if (breaker.state === "OPEN") {
    console.log("[REQ] OPEN: intentando eager probe rápido a X...");
    try {
      const text = await callWithTimeout(BUREAU_X_URL, EAGER_PROBE_TIMEOUT_MS);
      console.log("[REQ] Eager probe OK → cerramos y respondemos con X");
      breaker._toClosed();
      return { ok: true, used: "Buro X (recovered)", text, cb: breaker.state };
    } catch {
      console.log("[REQ] Eager probe falló/timeout → respondemos con Y");
      // caemos a Y
    }
  }

  // 3) Responder con Y
  const text = await call(BUREAU_Y_URL);
  return { ok: true, used: "Buro Y", text, cb: breaker.state };
}

// --- API HTTP ---
const SERVICE_PORT = process.env.SERVICE_PORT || 4000;

const server = http.createServer(async (req, res) => {
  // CORS básico
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.statusCode = 204; res.end(); return; }

  if (req.url.startsWith("/consulta")) {
    try {
      const out = await consultar();
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(out));
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
  console.log(`Servicio escuchando en http://localhost:${SERVICE_PORT} (eager+heartbeat activados)`)
);
