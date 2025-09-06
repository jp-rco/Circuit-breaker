const http = require("http");

const PORT = process.env.PORT || 3001;

let isOn = true; 

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/score") {
    if (!isOn) {
      res.statusCode = 500;   
      res.end("Buro X ERROR (apagado)");
      return;
    }
    res.statusCode = 200;
    res.end("Buro X");
    return;
  }

  if (url.pathname === "/admin/on") {
    isOn = true;
    res.statusCode = 200;
    res.end("Buro X encendido");
    return;
  }
  if (url.pathname === "/admin/off") {
    isOn = false;
    res.statusCode = 200;
    res.end("Buro X apagado");
    return;
  }
  if (url.pathname === "/admin/status") {
    res.statusCode = 200;
    res.end(JSON.stringify({ isOn }));
    return;
  }

  res.statusCode = 404;
  res.end("Not found");
});

server.listen(PORT, () =>
  console.log(`Buro X en http://localhost:${PORT} (admin: /admin/on | /admin/off | /admin/status)`)
);
