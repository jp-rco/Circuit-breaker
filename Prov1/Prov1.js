// bureau-x.js
import http from "http";

const PORT = process.env.PORT || 3001;

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/score")) {
    res.statusCode = 200;
    res.end("Buro X");
    return;
  }
  res.statusCode = 404;
  res.end("Not found");
});

server.listen(PORT, () =>
  console.log(`Buro X en http://localhost:${PORT}`)
);
