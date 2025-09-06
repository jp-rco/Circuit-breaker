// bureau-x.js
const http = require("http");

const PORT = process.env.PORT || 3001;
// Probabilidad de fallo (0..1). Puedes ajustar: FAIL_RATE=0.7 node bureau-x.js
const FAIL_RATE = parseFloat(process.env.FAIL_RATE || "0.7");

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/score")) {
    // Puedes forzar fallo con ?fail=1 para pruebas determinísticas
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const forced = url.searchParams.get("fail") === "1";

    const fail = forced || Math.random() < FAIL_RATE;
    if (fail) {
      res.statusCode = 500;
      res.end("Buro X ERROR");
    } else {
      res.statusCode = 200;
      res.end("Buro X");
    }
    return;
  }
  res.statusCode = 404;
  res.end("Not found");
});

server.listen(PORT, () =>
  console.log(`Buro X en http://localhost:${PORT} (FAIL_RATE=${FAIL_RATE})`)
);
