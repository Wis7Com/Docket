#!/usr/bin/env node
// Prints a free TCP port on 127.0.0.1, for launchers that must tell both the
// frontend server and the Electron main process which port to use.
//
// The backend gets this for free: Electron spawns it with PORT=0 and reads the
// assigned port back out of runtime.json. The Next.js standalone server has no
// equivalent channel — it only logs its port — so the launcher picks the port
// up front and passes it to both sides instead.
//
// Binding to port 0 and closing leaves a short window where something else
// could take the port. That window is microseconds wide, and losing it fails
// exactly the way a hardcoded port fails today, so it is strictly better than
// the fixed 3000 it replaces.
const net = require("node:net");

const server = net.createServer();

server.once("error", (error) => {
  console.error(`pick-free-port: ${error.message}`);
  process.exit(1);
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address !== "object") {
    console.error("pick-free-port: could not read the assigned port");
    process.exit(1);
  }
  const { port } = address;
  server.close(() => {
    process.stdout.write(String(port));
  });
});
