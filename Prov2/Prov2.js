const http = require("http");
const PORT = process.env.PORT || 3002;

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/score")) {
    res.statusCode = 200;
    res.end("Buro Y");
    return;
  }
  res.statusCode = 404;
  res.end("Not found");
});

server.listen(PORT, () =>
  console.log(`Buro Y en http://localhost:${PORT}`)
);
