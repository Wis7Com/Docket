const fs = require("fs");
const path = require("path");

fs.rmSync(path.join(__dirname, "..", "frontend", ".next", "dev"), {
  recursive: true,
  force: true,
});
